# Store promotional image

`promo-3840x2160.png` is the 16:9 hero art for the Microsoft Store listing (Partner Center > Store listings > Images >
"Super hero art", 3840 x 2160 PNG). It is drawn from `promo.html`, which uses the website's own stylesheet, fonts
(Bricolage Grotesque, Geist) and the light-theme screenshot `website/assets/img/hero-light.webp`, so it matches
dogfileio.vercel.app.

To change it, edit `promo.html` and run (needs Playwright with Chromium):

    node build/store/promo/render.mjs

To use a new screenshot, replace `website/assets/img/hero-light.webp` (about 2400 px wide or more keeps it sharp).

`wordmark.svg` is the DOGFILE lettering (traced from the brand image, so it needs no font); `logo.png` is the app icon.
