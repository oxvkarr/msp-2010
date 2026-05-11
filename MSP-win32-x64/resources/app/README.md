# MSPRetro - Client
This is the client embedding Flash Player to play [MSPRetro](https://mspretro.com).  
A MSPRetro browser version is in development.

## Requirements
- [NodeJS (tested with v20.16.0)](https://nodejs.org/en/)  
You have to install the dependencies with `npm install` before continue.

## Quick start

```powershell
npm install
npm start
```

If no MongoDB config is provided, the app starts with the local `msp-db.json` fallback so anyone cloning the repo can run it immediately.

## Launchers

The Windows package has two launchers:

- `MSP.exe` starts the player version without DevTools and noisy request logs.
- `MSP-Debug.exe` starts the developer version with DevTools and debug logging enabled.

When `MSP.exe` changes, run this command to refresh the debug launcher:

```powershell
npm run make-launchers
```

## MongoDB database
The local server can use MongoDB instead of `msp-db.json`.

To use a private MongoDB connection, create a local `.env` file based on `.env.example`.

Example `.env`:

```env
MONGODB_URI=mongodb+srv://USERNAME:PASSWORD@HOST/?appName=msp-2016
MONGODB_DB=msp_2016
MONGODB_STATE_COLLECTION=state
```

The `.env` file is ignored by git, so passwords and private connection strings are not published in the repository.

Do not put your private MongoDB Atlas password in GitHub. If you want everyone to write accounts into one shared online database, host this backend on a server and point clients to that backend. A public client should never contain the Atlas connection string.

For public players, use a remote gateway instead of MongoDB credentials in the client:

```env
REMOTE_GATEWAY_URL=https://your-server.example
```

With this set, the local client still serves Flash/assets, but all `Gateway.aspx` AMF calls are proxied to your hosted backend. That hosted backend is the only place that should have `MONGODB_URI`.

Right now the default hosted gateway is:

```text
https://msp-2016.onrender.com
```

So `MSP.exe` can start without creating `.env` first.

## Always-on backend

To run the backend on a VPS or another always-on host, upload this `resources/app` folder, create `.env`, and run:

```powershell
npm install
npm run start-server
```

Production `.env` for the hosted server:

```env
MSP_SERVER_ONLY=1
PORT=1600
MONGODB_URI=mongodb+srv://USERNAME:PASSWORD@HOST/?appName=msp-2016
MONGODB_DB=msp_2016
MONGODB_STATE_COLLECTION=state
REMOTE_ASSET_BASE_URL=https://pub-2ec8e3c2f0a24e46ab1defac06482eb3.r2.dev
```

If the host gives you its own port, keep `PORT` set to that value. You can check the backend with:

```text
https://your-server.example/api/health
```

Player clients should not contain `MONGODB_URI`. Give them only:

```env
REMOTE_GATEWAY_URL=https://your-server.example
REMOTE_ASSET_BASE_URL=https://pub-2ec8e3c2f0a24e46ab1defac06482eb3.r2.dev
```

## No terminal on Windows

For click-only usage inside `MSP-win32-x64`:

- `MSP.exe` starts the normal game client.
- `MSP-Debug.exe` starts the debug client.
- `MSP-Backend.vbs` starts the backend hidden in the background.
- `MSP-Backend-Stop.cmd` stops that backend process.

PowerShell example for local MongoDB without `.env`:

```powershell
$env:MONGODB_URI="mongodb://127.0.0.1:27017"
$env:MONGODB_DB="msp_2016"
npm start
```

Open `http://127.0.0.1/api/db/status` to check if the server is using `mongodb` or the JSON fallback.

## Remote assets

The client first serves files from `public`. If a file is missing and `REMOTE_ASSET_BASE_URL` is set, the server downloads that asset into `asset-cache` and serves it locally.

Example:

```env
REMOTE_ASSET_BASE_URL=https://your-domain.example/msp-assets
```

This lets release builds stay smaller: keep only the boot files locally, host the larger `swf`, `img`, `sounds`, and dictionary assets on your asset server, and let the client cache them when needed.

## Upload assets to R2

For large folders, use the S3-compatible uploader instead of the Cloudflare dashboard.

In Cloudflare, open `R2 Object Storage` overview, then find `Manage R2 API tokens` or `S3 API`, create a token with `Object Read & Write` for the `msp-assets` bucket, and copy the values into `.env`:

```env
CLOUDFLARE_ACCOUNT_ID=your_account_id
R2_BUCKET=msp-assets
R2_ACCESS_KEY_ID=your_access_key_id
R2_SECRET_ACCESS_KEY=your_secret_access_key
R2_UPLOAD_CONCURRENCY=24
```

Then upload:

```powershell
npm run upload-r2-assets
```

## Build for Windows
`npm run build-windows`

## Build for MacOS
`npm run build-darwin`
