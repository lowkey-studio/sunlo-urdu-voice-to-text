# Sunlo: Urdu voice notes to Urdu, Roman Urdu and English text

**Use it:** https://sunlo.appin60.com (free, no signup)

Sunlo turns Urdu voice notes and recordings (WhatsApp `.opus`, `.m4a`, `.mp3`, `.wav`) into:

- Urdu script (Nastaliq), never Devanagari, because the speech model is told the language is Urdu
- Roman Urdu, the way people type on WhatsApp
- an English translation

This repository is the source of the running service, published so anyone can check what happens to their audio.

## What happens to your audio

1. The browser decodes the file. Notes under about 3 MB are sent as they are; longer recordings are resampled to 16 kHz mono and cut into ~150-second pieces at the quietest moment near each boundary (`web/app.js`).
2. The Cloudflare Worker (`worker/worker.js`) passes the audio to Whisper large-v3-turbo on Cloudflare Workers AI with `language: 'ur'`, then sends the Urdu text to Llama 4 Scout for Roman Urdu and English.
3. The audio and the text are returned to you and not stored. The Worker writes only counters and metadata to its database: time, duration, size, file type, country, a device class, a salted daily hash of the IP for per-visitor limits, timing and success. A daily cron rolls these rows into per-day counts after 30 days and deletes them. Search the code for `INSERT INTO` to see every write.

Limits: a hard daily budget below the Workers AI free allocation, 10 minutes per file and 30 minutes a day per visitor for free use. A $4 pass (30 days) allows files up to 60 minutes; the free version stays free.

## Accuracy

`eval/` holds the test: the first 30 clips of the FLEURS Urdu (ur_pk) test split, 28 downloaded, encoded as Opus and sent through the live API. Word error rate 20.8% on clean clips, 23.0% with white noise at 15 dB SNR (`eval/eval_clean.json`, `eval/eval_noise15.json`, `eval/wer.py`). Real voice notes are harder than read sentences. One recognition slip can change the English badly, so check money, medicine, addresses and times against the audio. Details: https://sunlo.appin60.com/accuracy.html

## Install on Android

Open the site in Chrome, menu, "Install app". Sunlo then appears in WhatsApp's Share sheet (`web/manifest.webmanifest`, `share_target`, handled in `web/sw.js`).

## Contact

sunlo@appin60.com

Sunlo is independent and has no link to WhatsApp or Meta.

Licence: MIT for the code in this repository. FLEURS transcripts in `eval/` are CC BY 4.0 (Google).
