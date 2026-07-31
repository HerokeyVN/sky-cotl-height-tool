# Measuring Height Tool – notes on calculations

This file documents how the QR Height tool derives its numbers. All logic lives in `viewmodel/measuringHeight.ts`, `viewmodel/heightMath.ts`, and `viewmodel/qrDecoder.ts`.

## Data flow (inputs → outputs)
1. **Input**: a QR payload provides two raw numbers: `scale` and `height` (decoded in `qrDecoder.ts`).
2. **State**: the tool stores them as `comparisonScale` and `bodyHeightDelta` (both editable in the UI).
3. **Snapshot**: `computeHeightSnapshot(scale, heightMod)` derives:
   - `factor` (final scale factor)
   - `sizeType` (bucketed body size)
   - `baseHeight` (meters, before applying factor)
   - `height` (final meters)
   - `heightDelta` (final - base)

## Formula details
Constants:

- `ratioCoefficients` is the 3D-to-2D conversion coefficient set used for non-negative `heightMod` values.
- `ratioCoefficients2` is the 3D-to-2D conversion coefficient set used for negative `heightMod` values.
- The shorter side uses a separate fitted set because the projection curve is different there.

```txt
ratioCoefficients (heightMod >= 0)
   A = 1.095388425
   B = 0.004983453
   C = 0.492141518
   D = 0.002968009

ratioCoefficients2 (heightMod < 0)
   A = 1.224206561
   B = 0.012636310
   C = 0.495569563
   D = 0.004517799

SKY_REFERENCE_HEIGHT_M = 1
SHORTEST_HEIGHT_M = 0.8
TALLEST_HEIGHT_M = 1.2
SIZE_TYPE_MIN = 1
SIZE_TYPE_MAX = 14
OLD_RAW_MIN = -2
OLD_RAW_MAX = 2
OLD_SCALE_BUCKETS = 13.5
RATIO_PER_STEP = (TALLEST_HEIGHT_M / SHORTEST_HEIGHT_M) ^ (1 / (SIZE_TYPE_MAX - 1))
```

Steps:
1) **Scale component**
```
scaleComponent(s) = s >= 0 ? (1 + s) : 1 / (1 - s)
```

2) **Predicted ratio**
```
H = heightMod * 10            // amplify heightMod for the model
S = scaleComponent(scale)
coeffs = heightMod < 0 ? ratioCoefficients2 : ratioCoefficients
ratio = A + B*H + C*S + D*(H*S)   // A,B,C,D from coeffs
```

3) **Final scale factor**
```
baseRatio = ratio when scale=0, heightMod=0, using the same coeff set as the input heightMod
factor = ratio / baseRatio
referenceHeight = SKY_REFERENCE_HEIGHT_M * factor
```

4) **Size type bucketing**
```
raw = clamp(10 * (referenceHeight - 1), OLD_RAW_MIN, OLD_RAW_MAX)
scalar = (raw + 2) / 4
oldValue = floor((1 - scalar) * OLD_SCALE_BUCKETS)
sizeType = clamp(round(oldValue + 1), SIZE_TYPE_MIN, SIZE_TYPE_MAX) - 1
```
`sizeType` is an index-like value (0–13) used to pick a base height.

5) **Base height from size type**
```
stepsFromShortest = SIZE_TYPE_MAX - sizeType
baseHeight = SHORTEST_HEIGHT_M * (RATIO_PER_STEP ^ stepsFromShortest)
```

6) **Final height**
```
height = baseHeight * factor
heightDelta = height - baseHeight
```

`formatMeters` simply renders `height` with a fixed precision and `m` suffix.
