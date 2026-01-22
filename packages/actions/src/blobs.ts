/**
 * Some inverses are too big to put in an action as JSON. Undoing a sort of
 * 100M rows needs the previous 400 MB row order. Actions refer to such data
 * by id; the bytes live here, in memory, for as long as history needs them.
 */
export class BlobStore {
  private next = 1;
  private items = new Map<string, unknown>();

  put(value: unknown): string {
    const id = `blob:${this.next++}`;
    this.items.set(id, value);
    return id;
  }

  get<T>(id: string): T {
    if (!this.items.has(id)) throw new Error(`missing ${id} (history was cleared?)`);
    return this.items.get(id) as T;
  }

  has(id: string): boolean {
    return this.items.has(id);
  }

  clear(): void {
    this.items.clear();
  }

  get size(): number {
    return this.items.size;
  }
}
