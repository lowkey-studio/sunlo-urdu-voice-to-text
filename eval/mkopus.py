# Make a WhatsApp-like Opus file from a WAV, optionally with white noise at a given SNR (dB). 100 = no noise.
import soundfile as sf, numpy as np, sys
src, dst, snr = sys.argv[1], sys.argv[2], float(sys.argv[3])
x, sr = sf.read(src)
if snr < 99:
    rng = np.random.default_rng(0)
    x = np.clip(x + rng.normal(0, np.sqrt(np.mean(x**2) / 10**(snr / 10)), len(x)), -1, 1)
sf.write(dst, x, sr, format='OGG', subtype='OPUS')
