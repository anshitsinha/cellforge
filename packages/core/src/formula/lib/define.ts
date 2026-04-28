import { FUNCTIONS, type Fn } from "../evaluate";
import type { FunctionInfo } from "../functions";

/** Reference entries for functions defined in lib/, in definition order. */
export const LIBRARY_INFO: FunctionInfo[] = [];

/** Add a function: its implementation and its reference entry, together. */
export function define(info: FunctionInfo, fn: Fn): void {
  if (FUNCTIONS[info.name]) throw new Error(`${info.name} is defined twice`);
  FUNCTIONS[info.name] = fn;
  LIBRARY_INFO.push(info);
}
