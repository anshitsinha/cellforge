# Ask bar eval

The phrasing set (150 requests on a sample Sales sheet, from packages/ai/test/cases.ts) run through each answerer.
A local model is scored the same way with loopAnswerer({ model, noParser: true }).
Regenerate with `npm run eval`.

## Parser

150 of 150 right (100.0%); 0.03 ms per request on average.

| Category | Cases | Right | Accuracy | Mean ms | Slowest ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| sort | 21 | 21 | 100.0% | 0.04 | 0.17 |
| filter | 27 | 27 | 100.0% | 0.04 | 0.12 |
| pivot suggestions | 5 | 5 | 100.0% | 0.04 | 0.10 |
| text styles | 10 | 10 | 100.0% | 0.02 | 0.03 |
| number formats | 8 | 8 | 100.0% | 0.02 | 0.02 |
| freeze | 9 | 9 | 100.0% | 0.01 | 0.01 |
| hide / show | 14 | 14 | 100.0% | 0.03 | 0.09 |
| insert / delete | 17 | 17 | 100.0% | 0.02 | 0.06 |
| sheets | 7 | 7 | 100.0% | 0.01 | 0.02 |
| duplicates and highlights | 10 | 10 | 100.0% | 0.05 | 0.12 |
| dropdowns | 4 | 4 | 100.0% | 0.02 | 0.03 |
| undo / fill | 6 | 6 | 100.0% | 0.01 | 0.03 |
| other sheets | 9 | 9 | 100.0% | 0.03 | 0.09 |
| nonsense | 3 | 3 | 100.0% | 0.01 | 0.01 |

## Ask loop, no model

150 of 150 right (100.0%); 0.04 ms per request on average.

| Category | Cases | Right | Accuracy | Mean ms | Slowest ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| sort | 21 | 21 | 100.0% | 0.06 | 0.19 |
| filter | 27 | 27 | 100.0% | 0.06 | 0.19 |
| pivot suggestions | 5 | 5 | 100.0% | 0.06 | 0.15 |
| text styles | 10 | 10 | 100.0% | 0.02 | 0.04 |
| number formats | 8 | 8 | 100.0% | 0.02 | 0.04 |
| freeze | 9 | 9 | 100.0% | 0.02 | 0.03 |
| hide / show | 14 | 14 | 100.0% | 0.04 | 0.12 |
| insert / delete | 17 | 17 | 100.0% | 0.02 | 0.05 |
| sheets | 7 | 7 | 100.0% | 0.02 | 0.03 |
| duplicates and highlights | 10 | 10 | 100.0% | 0.08 | 0.17 |
| dropdowns | 4 | 4 | 100.0% | 0.05 | 0.08 |
| undo / fill | 6 | 6 | 100.0% | 0.02 | 0.03 |
| other sheets | 9 | 9 | 100.0% | 0.06 | 0.27 |
| nonsense | 3 | 3 | 100.0% | 0.01 | 0.01 |
