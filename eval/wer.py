# Word and character error rate of Sunlo output against FLEURS reference transcripts.
import json, re, sys
def norm(s):
    s = re.sub(r'[ً-ْٰ۪-ۭ]', '', s)
    s = s.replace('ي', 'ی').replace('ك', 'ک').replace('ۂ', 'ہ').replace('ة', 'ہ')
    return re.sub(r'[^\w\s]', ' ', s).split()
def ed(a, b):
    d = list(range(len(b) + 1))
    for i in range(1, len(a) + 1):
        p = d[:]; d[0] = i
        for j in range(1, len(b) + 1): d[j] = min(p[j] + 1, d[j - 1] + 1, p[j - 1] + (a[i - 1] != b[j - 1]))
    return d[-1]
E = N = CE = CN = ok = tot = 0
for r in json.load(open(sys.argv[1])):
    tot += 1
    if not r.get('text'): continue
    ok += 1; a, b = norm(r['ref']), norm(r['text']); E += ed(a, b); N += len(a)
    ca, cb = ''.join(a), ''.join(b); CE += ed(list(ca), list(cb)); CN += len(ca)
print(f'{ok}/{tot} clips returned text; WER {E/N:.1%} ({E}/{N} words); CER {CE/CN:.1%}')
