# python3 vectors.py model_q.npz vectors.json: pictures and what reference.py makes of them (as 32-bit pictures, so
# with texture and blending), for parity.ts to compare src/downscale.ts with.
import numpy as np, json, base64, sys
from lab import *
from feat import is_test
from reference import final_halve2
model = Model(sys.argv[1])
pairs = [p for p in load_pairs(limit=3000) if is_test(p['cls'])]
out = []
for p in pairs[::max(1, len(pairs) // 60)]:
    L = p['L']; ox, oy = p['reg'][0] % 2, p['reg'][1] % 2
    C = final_halve2(pad_even(L, ox, oy), model, True, True)
    C[C[..., 3] < 128] = (255, 255, 255, 0)
    out.append(dict(w=L.shape[1], h=L.shape[0], ox=int(ox), oy=int(oy), rgba=base64.b64encode(L.tobytes()).decode(), sw=C.shape[1], sh=C.shape[0], small=base64.b64encode(C.tobytes()).decode()))
json.dump(out, open(sys.argv[2], 'w'))
print(len(out), 'pictures')
