# AR Publisher

Drop a .glb scan, type its real size, get the AR page, QR code and print card.

## Run it (Mac)
1. Install Node.js from https://nodejs.org if you don't have it (check with `node -v`).
2. In Terminal:
   ```
   cd ~/Documents/GitHub/AR-QR/tools/publisher
   npm install
   npm start
   ```
3. Open http://localhost:4173

Product folders are written to the AR-QR repo root (two levels up). After building one, the page shows the git command to push it.

## What it does for each model
- Scales it to the real size you typed and sits it on the floor
- Cleans it (merge duplicate data) and, if over 100,000 triangles, reduces it so phones can load it
- Shrinks textures over 2048 px (needs `npm install` to have fetched `sharp`)
- Warns if the file is over 10 MB or the size looks wrong
- Writes index.html, model.glb, model-viewer.min.js, qr-universal.png, card.html into `<repo>/<name>/`

## No AI inside
It is plain code that repeats the same steps each time. Nothing is sent to any AI service.

## Settings
Change the public address in the Settings box on the page (saved in config.json). For paying clients use your own domain, so printed QR codes never depend on github.io.
