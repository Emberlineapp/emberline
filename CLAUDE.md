# Emberline

Single-file web app (index.html) that controls Puffco Peak Pro, original Peak (OG, Opal, Indiglow, Guardian) and Proxy over Web Bluetooth. Users run it in the Path browser on iPhone. Live site: https://emberlineapp.github.io/emberline/

## Repos
- Live: Emberlineapp/emberline (index.html is the live app, served by GitHub Pages)
- Test: taupespy-debug/test (test build, test tools, side sites like oldpeak.html, proxylab.html, ember-flap.html)
- Supabase edge function and SQL live in supabase/ (deploy the function by hand in the Supabase dashboard)

## How I like to work
- Short, plain language. No em dashes.
- Test-first for risky features: put it in the test build, I try it, then I say "add to live".
- Keep the test and live builds in sync except for test-only tools.
- The test build must never add RP to the leaderboard.
- After changing code, run a syntax check on the script blocks before pushing.

## Device notes
- Protocol is Puffco LoRaX (service e276967f...). READ 0x10, WRITE 0x11, blob open/write/close 0x20/0x22/0x26.
- Proxy stores numbers as int32 with scales (temps x10, times x200, dif/dia x4096, dpd x256, msoc/lbws x100). See intScale().
- Older firmware (api 2): moods go through /u/app/led/ca/N + oa/N + an 8-byte table color (see api2Mood). Hits are timed from heater duty (see heatHitStep).
- Proxy hits: the inhale reading pins at 1.0 while pulling and fades after, so only ~1.0 counts (see proxyHitStep).
- Never read or write the firmware update service (1d14d6ee...). It can turn a Peak off.
