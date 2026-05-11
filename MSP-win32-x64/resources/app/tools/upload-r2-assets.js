const fs = require('fs');
const path = require('path');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const mime = require('mime-types');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const appDir = path.join(__dirname, '..');
const sourceDir = path.resolve(appDir, process.env.R2_UPLOAD_DIR || 'public');
const bucket = process.env.R2_BUCKET || 'msp-assets';
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || process.env.R2_ACCOUNT_ID;
const accessKeyId = process.env.R2_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID;
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY;
const concurrency = Math.max(1, Number(process.env.R2_UPLOAD_CONCURRENCY || 24));

if (!accountId || !accessKeyId || !secretAccessKey) {
    console.error('Missing R2 credentials. Set CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY in .env.');
    process.exit(1);
}

if (!fs.existsSync(sourceDir)) {
    console.error(`Upload directory does not exist: ${sourceDir}`);
    process.exit(1);
}

const client = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
        accessKeyId,
        secretAccessKey
    }
});

const walk = (dir, result = []) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            walk(fullPath, result);
        } else if (entry.isFile()) {
            result.push(fullPath);
        }
    }
    return result;
};

const keyFor = (filePath) => path.relative(sourceDir, filePath).replace(/\\/g, '/');

const uploadOne = async (filePath) => {
    const key = keyFor(filePath);
    const contentType = mime.lookup(filePath) || 'application/octet-stream';
    await client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: fs.createReadStream(filePath),
        ContentType: contentType
    }));
    return key;
};

const run = async () => {
    const files = walk(sourceDir);
    let uploaded = 0;
    let failed = 0;
    let index = 0;

    console.log(`Uploading ${files.length} files from ${sourceDir}`);
    console.log(`Bucket: ${bucket}, concurrency: ${concurrency}`);

    const workers = Array.from({ length: concurrency }, async () => {
        while (index < files.length) {
            const filePath = files[index++];
            try {
                const key = await uploadOne(filePath);
                uploaded++;
                if (uploaded % 25 === 0 || uploaded === files.length) {
                    console.log(`[${uploaded}/${files.length}] ${key}`);
                }
            } catch (err) {
                failed++;
                console.error(`[FAIL] ${keyFor(filePath)} ${err.message}`);
            }
        }
    });

    await Promise.all(workers);
    console.log(`Finished. Uploaded: ${uploaded}, failed: ${failed}`);
    if (failed > 0) process.exitCode = 1;
};

run().catch((err) => {
    console.error(err.stack || err.message);
    process.exitCode = 1;
});
