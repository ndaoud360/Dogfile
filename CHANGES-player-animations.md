# Player animations (record player + cassette deck)

Replace/add these files (relative to your repo root):
- src/renderer/js/playerskin.js            (new: the animations)
- src/renderer/js/player.js                (skin hooks: song starts after the needle drops / lid closes)
- src/renderer/js/ext-worker.js            (dogfile.player.setSkin / getSkin)
- src/renderer/js/featureapi.js            (docs for those two calls)
- FEATURES.md, src/renderer/assets/FEATURES.md   (regenerated)
- mods/player-animations/                  (the mod source + "Player animations.dogmod")

Install: double-click "Player animations.dogmod" (or Manage features > Import), then in the Player use
Features > "Music view: record player" / "cassette deck" / "cover picture". The choice is remembered.

Note: player.js was edited against the repo as currently on GitHub; if you changed player.js since, re-apply the small hooks (search "skins").
