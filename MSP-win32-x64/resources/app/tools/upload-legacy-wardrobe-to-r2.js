const fs = require('fs');
const path = require('path');
const { S3Client, HeadObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const mime = require('mime-types');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const args = process.argv.slice(2);
const argValue = (name, fallback = '') => {
    const index = args.indexOf(name);
    return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const hasFlag = (name) => args.includes(name);
const sourceRoot = path.resolve(argValue('--source', process.env.LEGACY_SWF_SOURCE || 'C:/Users/oskar/Downloads/2009-2013 SWFS'));
const r2Prefix = argValue('--prefix', process.env.R2_WARDROBE_PREFIX || '2010').replace(/^\/+|\/+$/g, '');
const doUpload = hasFlag('--upload');
const overwrite = hasFlag('--overwrite');
const concurrency = Math.max(1, Number(argValue('--concurrency', process.env.R2_UPLOAD_CONCURRENCY || 12)));

const bucket = process.env.R2_BUCKET || 'msp-assets';
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || process.env.R2_ACCOUNT_ID;
const accessKeyId = process.env.R2_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID;
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY;

if (!fs.existsSync(sourceRoot)) {
    console.error(`Source folder does not exist: ${sourceRoot}`);
    process.exit(1);
}

if (!accountId || !accessKeyId || !secretAccessKey) {
    console.error('Missing R2 credentials. Set CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY in .env.');
    process.exit(1);
}

const mappings = [
    { from: ['Hair'], to: 'swf/hair' },
    { from: ['Clothing', 'Tops'], to: 'swf/tops' },
    { from: ['Clothing', 'Pants'], to: 'swf/bottoms' },
    { from: ['Clothing', 'Tights-Socks'], to: 'swf/bottoms' },
    { from: ['Clothing', 'Shoes'], to: 'swf/footwear' }
];

const client = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey }
});

const walk = (dir, result = []) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            walk(fullPath, result);
        } else if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.swf') {
            result.push(fullPath);
        }
    }
    return result;
};

const relativeParts = (filePath) => path.relative(sourceRoot, filePath).split(path.sep);

const mappedKey = (filePath) => {
    const parts = relativeParts(filePath);
    const mapping = mappings.find((item) => item.from.every((part, index) => parts[index] === part));
    if (!mapping) return null;
    return `${r2Prefix}/${mapping.to}/${parts[parts.length - 1]}`.replace(/\\/g, '/');
};

const candidates = walk(sourceRoot)
    .map((filePath) => ({ filePath, key: mappedKey(filePath) }))
    .filter((item) => item.key)
    .sort((a, b) => a.key.localeCompare(b.key, 'en', { sensitivity: 'base' }));

const counts = candidates.reduce((acc, item) => {
    const bucketKey = item.key.replace(`${r2Prefix}/`, '').split('/').slice(0, 2).join('/');
    acc[bucketKey] = (acc[bucketKey] || 0) + 1;
    return acc;
}, {});

const existsOnR2 = async (key) => {
    try {
        await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return true;
    } catch (_) {
        return false;
    }
};

const uploadOne = async (item) => {
    if (!overwrite && await existsOnR2(item.key)) {
        return { key: item.key, status: 'skip' };
    }

    await client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: item.key,
        Body: fs.createReadStream(item.filePath),
        ContentType: mime.lookup(item.filePath) || 'application/x-shockwave-flash'
    }));
    return { key: item.key, status: 'upload' };
};

const run = async () => {
    console.log(`Source: ${sourceRoot}`);
    console.log(`R2: ${bucket}/${r2Prefix}`);
    console.log(`Mode: ${doUpload ? 'UPLOAD' : 'DRY RUN'}${overwrite ? ' + overwrite' : ''}`);
    console.log('Counts:', counts);
    console.log(`Matched SWF files: ${candidates.length}`);

    for (const item of candidates.slice(0, 20)) {
        console.log(`[MAP] ${path.relative(sourceRoot, item.filePath)} -> ${item.key}`);
    }
    if (candidates.length > 20) console.log(`[MAP] ... ${candidates.length - 20} more`);

    if (!doUpload) {
        console.log('Dry run only. Add --upload to send files to R2.');
        return;
    }

    let index = 0;
    let uploaded = 0;
    let skipped = 0;
    let failed = 0;

    const workers = Array.from({ length: concurrency }, async () => {
        while (index < candidates.length) {
            const item = candidates[index++];
            try {
                const result = await uploadOne(item);
                if (result.status === 'skip') skipped++;
                if (result.status === 'upload') uploaded++;
                const done = uploaded + skipped + failed;
                if (done % 25 === 0 || done === candidates.length) {
                    console.log(`[${done}/${candidates.length}] uploaded=${uploaded} skipped=${skipped} failed=${failed} last=${result.key}`);
                }
            } catch (err) {
                failed++;
                console.error(`[FAIL] ${item.key} ${err.message}`);
            }
        }
    });

    await Promise.all(workers);
    console.log(`Finished. Uploaded: ${uploaded}, skipped: ${skipped}, failed: ${failed}`);
    if (failed > 0) process.exitCode = 1;
};

run().catch((err) => {
    console.error(err.stack || err.message);
    process.exitCode = 1;
});
