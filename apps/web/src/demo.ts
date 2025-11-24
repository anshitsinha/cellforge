import type { CellValue, DataSource } from "@cellforge/grid";

const REGIONS = ["North", "South", "East", "West", "Central"];
const PRODUCTS = ["Laptop", "Monitor", "Keyboard", "Mouse", "Headset", "Webcam", "Dock"];
const HEADERS = ["order_id", "date", "region", "product", "units", "unit_price", "discount"];

/**
 * Fake sales data, computed on demand from the row index. Nothing is stored,
 * so we can "have" 100M rows with zero memory - handy for testing the grid
 * before the real columnar store exists.
 */
export class SyntheticSource implements DataSource {
  readonly colCount = HEADERS.length;

  constructor(readonly rowCount: number) {}

  getColumnName(col: number): string {
    return HEADERS[col];
  }

  getCell(row: number, col: number): CellValue {
    const h = hash(row);
    switch (col) {
      case 0:
        return row + 1;
      case 1: {
        // spread orders over ~5 years starting 2021-01-01
        const day = h % 1826;
        return new Date(Date.UTC(2021, 0, 1 + day)).toISOString().slice(0, 10);
      }
      case 2:
        return REGIONS[(h >>> 3) % REGIONS.length];
      case 3:
        return PRODUCTS[(h >>> 7) % PRODUCTS.length];
      case 4:
        return 1 + ((h >>> 11) % 20);
      case 5:
        return Math.round(((h >>> 13) % 150000) + 999) / 100;
      case 6:
        return ((h >>> 17) % 4) * 0.05;
      default:
        return null;
    }
  }
}

/** Cheap integer hash (murmur3 finalizer) so values look random but are stable. */
function hash(n: number): number {
  let x = n | 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return x >>> 0;
}
