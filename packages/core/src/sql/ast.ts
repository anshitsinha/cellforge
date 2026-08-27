/** The parsed form of a query. Every expression keeps where it was in the text. */

export type BinOp = "+" | "-" | "*" | "/" | "%" | "||" | "=" | "<>" | "<" | "<=" | ">" | ">=" | "AND" | "OR";

export interface FrameBound {
  /** "unbounded" preceding/following, "current" row, or an offset */
  kind: "unbounded" | "current" | "offset";
  /** -1 for preceding, +1 for following (offset and unbounded) */
  dir: -1 | 1;
  n: number;
}

export interface OrderItem {
  e: Expr;
  desc: boolean;
  /** undefined = the default: NULLS LAST for ASC, NULLS FIRST for DESC */
  nullsFirst?: boolean;
}

export interface WindowSpec {
  partition: Expr[];
  order: OrderItem[];
  frame?: { rows: boolean; start: FrameBound; end: FrameBound };
}

interface At {
  pos: number;
  end: number;
}

export type Expr = At &
  (
    | { k: "lit"; v: number | string | boolean | null; date?: boolean }
    | { k: "col"; table?: string; name: string }
    | { k: "star"; table?: string }
    | { k: "unary"; op: "-" | "NOT"; e: Expr }
    | { k: "bin"; op: BinOp; l: Expr; r: Expr }
    | { k: "isnull"; e: Expr; not: boolean }
    | { k: "between"; e: Expr; lo: Expr; hi: Expr; not: boolean }
    | { k: "in"; e: Expr; list?: Expr[]; sub?: Query; not: boolean }
    | { k: "like"; e: Expr; pat: Expr; not: boolean; ci: boolean; esc?: string }
    | { k: "case"; base?: Expr; whens: { when: Expr; then: Expr }[]; else?: Expr }
    | { k: "cast"; e: Expr; to: "num" | "str" | "date" | "int" }
    | { k: "fn"; name: string; args: Expr[]; distinct: boolean; star: boolean; over?: WindowSpec }
    | { k: "sub"; q: Query }
    | { k: "exists"; q: Query; not: boolean }
  );

export interface SelectItem {
  e: Expr;
  alias?: string;
}

export type From = At &
  (
    | { k: "table"; name: string; alias?: string }
    | { k: "sub"; q: Query; alias?: string }
    | { k: "join"; type: "inner" | "left" | "right" | "full" | "cross"; l: From; r: From; on?: Expr; using?: string[] }
  );

export interface Select extends At {
  k: "select";
  distinct: boolean;
  items: SelectItem[];
  from?: From;
  where?: Expr;
  groupBy: Expr[];
  having?: Expr;
}

export interface SetOp extends At {
  k: "setop";
  op: "union" | "except" | "intersect";
  all: boolean;
  l: QueryBody;
  r: QueryBody;
}

export type QueryBody = Select | SetOp | (At & { k: "paren"; q: Query });

export interface Query extends At {
  with: { name: string; q: Query; pos: number }[];
  body: QueryBody;
  order: OrderItem[];
  limit?: Expr;
  offset?: Expr;
}
