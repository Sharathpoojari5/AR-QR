# AR QR Maker (website)

Anyone opens the site, drops a .glb, types a name and one real measurement, and gets a QR code
that opens the object in AR at true size. No login, no install.

How it works
- The browser cleans and scales the model (so your server does almost no work), then uploads it.
- A Cloudflare Worker stores it in R2 and serves one AR page per model at /p/<name>-<code>/.
- The QR is made in the browser and points to that page.
- Each upload returns a private key, kept in that person's browser, which lets them delete it later.

## One-time setup (about 10 minutes)
You need a free Cloudflare account (https://dash.cloudflare.com/sign-up). Then, in Terminal:

    cd ~/Documents/GitHub/AR-QR/tools/website
    npm install
    npx wrangler login                      # opens a browser, click Allow
    npx wrangler r2 bucket create ar-models # needs R2 enabled once in the dashboard (free tier)
    npm run deploy

The last command prints your site address, like https://ar-qr-maker.<yourname>.workers.dev

## Before printing QR codes for clients: use your own domain
QR codes contain the site address. If you ever change the address, printed QRs break.
1. Buy a short domain (e.g. yourbrand.in) and add it to Cloudflare (Websites > Add a site).
2. Cloudflare dashboard > Workers & Pages > ar-qr-maker > Settings > Domains & Routes > Add custom domain.
3. Only share and print QRs made on that domain.

## Optional: lock uploads with a passcode
    npx wrangler secret put PASSCODE
Type a passcode. The site then asks for it before uploading. Remove with `npx wrangler secret delete PASSCODE`.

## Protect against abuse (recommended, free)
A public upload page can be misused. In the Cloudflare dashboard, for your domain:
- Security > WAF > Rate limiting rules > create a rule: URI path equals /api/upload, 10 requests per 10 minutes per IP, action Block.
- Uploads are limited to 30 MB and must be a real GLB.
- R2 free tier is 10 GB. Watch usage under R2 > Overview.

## Run locally to test
    npm run dev       # http://localhost:8787

## Files
- public/index.html, src/client.js : the page and in-browser processing (built into public/app.js)
- src/worker.js : upload, storage, delete, and the AR page
- public/_tpl/index.html : the AR page template (edit this to change every product page)
