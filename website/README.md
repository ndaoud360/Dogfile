# Dogfile website

Plain HTML, CSS and JavaScript. No build step, no framework, nothing to install.

```
index.html      home page
download.html   Free vs Pro comparison, Download now and Buy now
thanks.html     where Stripe sends buyers: shows the serial number
contact.html    contact form
legal.html      terms, refunds and privacy
404.html        page not found
assets/css/site.css         all styles (colors and fonts are at the top)
assets/js/config.js         license server and release addresses
assets/js/theme.js          keeps the light/dark choice
assets/js/site.js           theme button, menu, Buy and Download buttons
assets/js/thanks.js         the thank-you page
assets/js/contact.js        the contact form
assets/img/                 screenshots and icons
assets/video/               the fold animation, macro recorder and due date videos
assets/fonts/               Bricolage Grotesque, Geist and Geist Mono (SIL Open Font License)
vercel.json                 security headers and short links for Vercel
```

## Preview on your PC

From this folder: `python -m http.server 8000`, then open http://localhost:8000. (Opening the files by double-clicking
works for looking, but the Buy and Download buttons need a real web address.)

## Put it online with Vercel (free)

1. Push the repository to GitHub (it already is).
2. On vercel.com choose **Add New › Project**, import the repository, and set **Root Directory** to `website`.
   Framework preset: **Other**. No build command, no output directory.
3. Deploy. Vercel gives you an address like `dogfile.vercel.app`; you can add your own domain under
   **Settings › Domains**.
4. Nothing else is needed for buying: every Buy button tells the license server which site it's on, and after
   paying, Stripe sends the buyer back to that site's `thanks.html` (or `download.html?cancelled=1` if they cancel).
   The server only accepts Dogfile's own sites: `dogfile*.vercel.app`, any `dogfile.*` domain, and localhost. If the
   site lives anywhere else (your own domain without "dogfile" in it), add it in Supabase, project
   `armnbgeluofwseufpqge`, **Edge Functions › Secrets**: `SITE_HOSTS` = `yourdomain.com,www.yourdomain.com`.
   Optional: `SUCCESS_URL` = `https://YOUR-DOMAIN/thanks.html` and `CANCEL_URL` = `https://YOUR-DOMAIN/download.html?cancelled=1`
   are used when the browser doesn't say which site it came from (no `?` in SUCCESS_URL: the server adds `?session_id=…`).

## Things to fill in

- **Microsoft Store link**: Download Free buttons lead to the Free vs Pro page (`download.html#get`), and the Download
  Free buttons there and on the thank-you page open `https://apps.microsoft.com/search?query=Dogfile` for now. When
  Dogfile's Store page is live, search the HTML files for `apps.microsoft.com` and replace each match with the real
  link. (Also set the same link as `STORE_URL` in Supabase's Edge Function secrets, for the server's plain fallback page.)
- **Contact form**: messages go to nd640dev@gmail.com (the `data-email` in `contact.html`). The first message ever
  sent makes FormSubmit email that address a one-time "activate your form" link; click it once. The app's
  Help > Report a bug sends through the same address, so activating once covers both.
- **Social preview image**: `og:image` in each page's `<head>` is a relative path. Once you know the domain, change it
  to the full address (`https://YOUR-DOMAIN/assets/img/og-image.jpg`) so link previews show the picture everywhere.
- **Terms and refunds**: read `legal.html` and adjust it to what you want to promise (it says 30-day refunds).

## Replacing screenshots and the animation

Every screenshot sits in a frame with a fixed 16:10 shape, so any image you drop in fits; it's cropped from the top
left if its shape is different. Keep the same file name and replace the file:

| File | Where it shows |
| --- | --- |
| `assets/img/hero-light.webp`, `hero-dark.webp` | The big window at the top (light and dark mode versions) |
| `assets/img/feature-panes.webp`, `feature-preview.webp`, `feature-office.webp` | The three scrolling features |
| `assets/img/preset-midnight.webp`, `preset-nord.webp`, `preset-rose.webp`, `preset-solarized.webp` | Themes |
| `assets/img/app-audio.webp`, `app-video.webp`, `app-notepad.webp`, `app-3d.webp` | Built-in apps |
| `assets/img/terminal.webp`, `assistant.webp` | Terminal and AI assistant sections |
| `assets/img/mods.webp` | Make Your Own Features |
| `assets/video/macro.mp4`, `assets/img/macro-poster.webp` | Macro Recorder (the poster shows before the video loads) |
| `assets/video/reminders.mp4`, `assets/img/reminders-poster.webp` | Never Miss a Due Date (the sample car loan statement is made up) |
| `assets/video/fold.webm`, `fold.mp4`, `assets/img/fold-poster.webp` | Animations (a looping video is about 10x smaller than a GIF and looks sharper) |
| `assets/img/og-image.jpg` | The picture shown when someone shares a link (1200×630) |

PNG or JPG work too: change the file name in the HTML (search for the old name). For the best quality and size,
save screenshots at about 2000 pixels wide; to make WebP files, `cwebp -q 82 in.png -o out.webp`.

To make a new fold video from a screen recording: `ffmpeg -i in.mp4 -vf scale=1440:-2 -an -c:v libvpx-vp9 -crf 34 -b:v 0 fold.webm`
and `ffmpeg -i in.mp4 -vf scale=1440:-2 -an -c:v libx264 -crf 22 -movflags +faststart -pix_fmt yuv420p fold.mp4`.

## How buying works

1. Every **Buy** button is a plain link to the license server's `/buy` (opened in a new tab, with `?site=` saying which
   site it's on). The server creates a Stripe checkout for
   $19.99 with a serial number already chosen, and sends the browser straight to it. No script is involved, so it
   works even with JavaScript off or an ad blocker on.
2. After paying, Stripe sends the buyer to `thanks.html?session_id=…`. The page asks the server (`GET /claim`) for the
   serial number and shows it with Copy and Save buttons, and reminds them to keep it.
3. The license is created by whichever arrives first: Stripe's webhook, the thank-you page, or the app itself.
4. Cancelling at Stripe returns to `download.html?cancelled=1`, which says nothing was charged. If the checkout can't
   be opened at all, `/buy` sends the buyer to `download.html?failed=1` instead.

The serial number is only emailed if the license server has an email service (a `RESEND_API_KEY` secret in
Supabase). Until then the thank-you page is where buyers get it, which is why it insists they save it.

**Price**: it's written in the pages (search for `$19.99`). The amount actually charged is `PRICE_CENTS` in
`supabase/functions/license/core.ts`. Change both together.

## Download button

Download Free goes to the Free vs Pro page, scrolled to its Download Free button, which opens Dogfile's page in the
Microsoft Store in a new tab (see "Things to fill in"). After buying Pro, the thank-you
page shows the serial number, a Download Free button for anyone who doesn't have the app yet, and the steps to
activate: Settings > License > Enter serial number.

## Comparison table

The "What Dogfile Has That Others Don't" table compares Dogfile with Directory Opus, OneCommander and Total Commander, from
their own websites in October 2026 (built-in features only). Re-check it now and then: competitors add features, and a
comparison that's out of date is a claim you'd have to correct. The rows are in `index.html` (search for `compare vs`).

## Button wording

Every download button says **Download Free** and every buy button says **Buy Pro $19.99**. Links to other sites
(the Store, Stripe) open in a new tab. Keep it that way if you
add buttons, so people always know what a button does.
