# Ask bar eval

The phrasing set (171 requests on a sample Sales sheet, from packages/ai/test/cases.ts) run through each answerer.
A local model is scored the same way with loopAnswerer({ model, noParser: true }).
Regenerate with `npm run eval`.

## Parser

171 of 171 right (100.0%); 0.03 ms per request on average.

| Category | Cases | Right | Accuracy | Mean ms | Slowest ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| sort | 21 | 21 | 100.0% | 0.03 | 0.11 |
| filter | 27 | 27 | 100.0% | 0.04 | 0.15 |
| pivot suggestions | 6 | 6 | 100.0% | 0.05 | 0.11 |
| single figures | 12 | 12 | 100.0% | 0.03 | 0.12 |
| journal flags | 8 | 8 | 100.0% | 0.04 | 0.09 |
| text styles | 10 | 10 | 100.0% | 0.02 | 0.03 |
| number formats | 8 | 8 | 100.0% | 0.02 | 0.03 |
| freeze | 9 | 9 | 100.0% | 0.01 | 0.01 |
| hide / show | 14 | 14 | 100.0% | 0.03 | 0.10 |
| insert / delete | 17 | 17 | 100.0% | 0.02 | 0.05 |
| sheets | 7 | 7 | 100.0% | 0.03 | 0.08 |
| duplicates and highlights | 10 | 10 | 100.0% | 0.05 | 0.13 |
| dropdowns | 4 | 4 | 100.0% | 0.02 | 0.03 |
| undo / fill | 6 | 6 | 100.0% | 0.01 | 0.02 |
| other sheets | 9 | 9 | 100.0% | 0.02 | 0.07 |
| nonsense | 3 | 3 | 100.0% | 0.01 | 0.01 |

## Ask loop, no model

171 of 171 right (100.0%); 0.04 ms per request on average.

| Category | Cases | Right | Accuracy | Mean ms | Slowest ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| sort | 21 | 21 | 100.0% | 0.05 | 0.22 |
| filter | 27 | 27 | 100.0% | 0.05 | 0.17 |
| pivot suggestions | 6 | 6 | 100.0% | 0.09 | 0.27 |
| single figures | 12 | 12 | 100.0% | 0.03 | 0.08 |
| journal flags | 8 | 8 | 100.0% | 0.05 | 0.12 |
| text styles | 10 | 10 | 100.0% | 0.03 | 0.04 |
| number formats | 8 | 8 | 100.0% | 0.02 | 0.03 |
| freeze | 9 | 9 | 100.0% | 0.01 | 0.02 |
| hide / show | 14 | 14 | 100.0% | 0.03 | 0.09 |
| insert / delete | 17 | 17 | 100.0% | 0.02 | 0.05 |
| sheets | 7 | 7 | 100.0% | 0.01 | 0.02 |
| duplicates and highlights | 10 | 10 | 100.0% | 0.05 | 0.12 |
| dropdowns | 4 | 4 | 100.0% | 0.03 | 0.04 |
| undo / fill | 6 | 6 | 100.0% | 0.01 | 0.02 |
| other sheets | 9 | 9 | 100.0% | 0.03 | 0.08 |
| nonsense | 3 | 3 | 100.0% | 0.01 | 0.02 |
