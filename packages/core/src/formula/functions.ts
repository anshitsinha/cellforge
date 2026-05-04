import { LIBRARY_INFO } from "./lib/define";
import { SPECIAL_INFO } from "./lib/special-info";
import "./lib/lookup";
import "./lib/maths";
import "./lib/stats";
import "./lib/text";
import "./lib/logic";
import "./lib/financial";
import "./lib/dates";
import "./lib/arrayfns";

/**
 * What every function is for, its arguments and worked examples. This is
 * the single source for the function reference in the docs, the
 * autocomplete and argument hints while typing, and the AI's tool
 * descriptions. Every example is also a test: it must evaluate to exactly
 * what it says.
 */

export type FunctionCategory = "Maths" | "Statistics" | "Logic" | "Text" | "Lookup" | "Date and time" | "Information" | "Financial";

export interface FunctionArg {
  name: string;
  description: string;
  optional?: boolean;
  /** can be given more than once (number1, number2, ...) */
  repeats?: boolean;
}

export interface FunctionInfo {
  name: string;
  category: FunctionCategory;
  summary: string;
  args: FunctionArg[];
  /** formula -> what it shows. Cells referenced come from EXAMPLE_CELLS. */
  examples: [string, string | number | boolean][];
  /** differences from Excel worth knowing, if any */
  notes?: string;
}

/**
 * The little table every example can refer to:
 *   A1:A5 = 10, 20, 30, "apple", (empty)
 *   B1:B5 = "North", "South", "North", "East", "South"
 *   C1    = "  padded  text "
 *   D1    = 45306 (15 January 2024 as a date serial), D2 = "2024-03-31" (text)
 *   E1:E5 / F1:F5 = cash flows and their dates, G1:G6 = yearly cash flows
 *   (Microsoft's own XIRR, XNPV and IRR examples, so results match its docs)
 */
export const EXAMPLE_CELLS: Record<string, string | number> = {
  A1: 10,
  A2: 20,
  A3: 30,
  A4: "apple",
  B1: "North",
  B2: "South",
  B3: "North",
  B4: "East",
  B5: "South",
  C1: "  padded  text ",
  D1: 45306,
  D2: "2024-03-31",
  // cash flows and dates from Microsoft's XIRR / XNPV documentation
  E1: -10000, E2: 2750, E3: 4250, E4: 3250, E5: 2750,
  F1: 39448, F2: 39508, F3: 39751, F4: 39859, F5: 39904,
  // and from its IRR documentation
  G1: -70000, G2: 12000, G3: 15000, G4: 18000, G5: 21000, G6: 26000,
};

const num = (name: string, description: string, extra: Partial<FunctionArg> = {}): FunctionArg => ({ name, description, ...extra });

const LIST: FunctionInfo[] = [
  // ---------------------------------------------------------------- maths
  {
    name: "SUM",
    category: "Maths",
    summary: "Adds numbers. Text and empty cells inside ranges are skipped.",
    args: [num("number1", "a number, a cell or a range"), num("number2", "more numbers, cells or ranges", { optional: true, repeats: true })],
    examples: [
      ["=SUM(A1:A3)", 60],
      ["=SUM(A1:A5, 5)", 65],
    ],
  },
  {
    name: "ABS",
    category: "Maths",
    summary: "The number without its sign.",
    args: [num("number", "any number")],
    examples: [["=ABS(-4.5)", 4.5]],
  },
  {
    name: "SQRT",
    category: "Maths",
    summary: "Square root. A negative number gives #NUM!.",
    args: [num("number", "zero or more")],
    examples: [
      ["=SQRT(16)", 4],
      ["=SQRT(-1)", "#NUM!"],
    ],
  },
  {
    name: "INT",
    category: "Maths",
    summary: "Rounds down to a whole number (towards minus infinity).",
    args: [num("number", "any number")],
    examples: [
      ["=INT(7.9)", 7],
      ["=INT(-7.1)", -8],
    ],
  },
  {
    name: "ROUND",
    category: "Maths",
    summary: "Rounds to a number of decimal places, halves away from zero (2.5 → 3, -2.5 → -3).",
    args: [num("number", "the number to round"), num("digits", "decimal places; negative rounds to tens, hundreds...")],
    examples: [
      ["=ROUND(2.345, 2)", 2.35],
      ["=ROUND(1234, -2)", 1200],
      ["=ROUND(-2.5, 0)", -3],
    ],
  },
  {
    name: "MOD",
    category: "Maths",
    summary: "The remainder after dividing, with the sign of the divisor (as in Excel).",
    args: [num("number", "the number to divide"), num("divisor", "what to divide by; 0 gives #DIV/0!")],
    examples: [
      ["=MOD(10, 3)", 1],
      ["=MOD(-10, 3)", 2],
    ],
  },
  {
    name: "POWER",
    category: "Maths",
    summary: "A number raised to a power; the same as the ^ operator.",
    args: [num("number", "the base"), num("power", "the exponent")],
    examples: [["=POWER(2, 10)", 1024]],
  },
  // ----------------------------------------------------------- statistics
  {
    name: "AVERAGE",
    category: "Statistics",
    summary: "The mean of the numbers. Text and empty cells in ranges are skipped; no numbers gives #DIV/0!.",
    args: [num("number1", "a number, a cell or a range"), num("number2", "more", { optional: true, repeats: true })],
    examples: [["=AVERAGE(A1:A5)", 20]],
  },
  {
    name: "MIN",
    category: "Statistics",
    summary: "The smallest number (0 if there are none).",
    args: [num("number1", "a number, a cell or a range"), num("number2", "more", { optional: true, repeats: true })],
    examples: [["=MIN(A1:A5)", 10]],
  },
  {
    name: "MAX",
    category: "Statistics",
    summary: "The largest number (0 if there are none).",
    args: [num("number1", "a number, a cell or a range"), num("number2", "more", { optional: true, repeats: true })],
    examples: [["=MAX(A1:A5, 25)", 30]],
  },
  {
    name: "COUNT",
    category: "Statistics",
    summary: "How many numbers there are.",
    args: [num("value1", "a value, a cell or a range"), num("value2", "more", { optional: true, repeats: true })],
    examples: [["=COUNT(A1:A5)", 3]],
  },
  {
    name: "COUNTA",
    category: "Statistics",
    summary: "How many cells aren't empty.",
    args: [num("value1", "a value, a cell or a range"), num("value2", "more", { optional: true, repeats: true })],
    examples: [["=COUNTA(A1:A5)", 4]],
  },
  {
    name: "COUNTIF",
    category: "Statistics",
    summary: 'How many cells in a range meet a condition: a value ("North"), a comparison (">15") or a wildcard ("N*").',
    args: [num("range", "the cells to check"), num("criteria", 'what to count, e.g. "North", ">15", "<>East"')],
    examples: [
      ['=COUNTIF(B1:B5, "North")', 2],
      ['=COUNTIF(A1:A5, ">15")', 2],
    ],
  },
  {
    name: "SUMIF",
    category: "Statistics",
    summary: "Adds the cells that meet a condition, optionally from a parallel range.",
    args: [
      num("range", "the cells to check"),
      num("criteria", 'the condition, e.g. "North" or ">15"'),
      num("sum_range", "the cells to add, if not the ones checked", { optional: true }),
    ],
    examples: [
      ['=SUMIF(B1:B5, "North", A1:A5)', 40],
      ['=SUMIF(A1:A5, ">15")', 50],
    ],
  },
  // ---------------------------------------------------------------- logic
  {
    name: "IF",
    category: "Logic",
    summary: "One value if a condition is true, another if it's false.",
    args: [
      num("condition", "something true or false, e.g. A1>15"),
      num("value_if_true", "what to show when it's true"),
      num("value_if_false", "what to show otherwise (FALSE if left out)", { optional: true }),
    ],
    examples: [
      ['=IF(A1>15, "high", "low")', "low"],
      ['=IF(A3>15, "high", "low")', "high"],
    ],
  },
  {
    name: "IFERROR",
    category: "Logic",
    summary: "A value, or something else if that value is an error.",
    args: [num("value", "a formula that might fail"), num("value_if_error", "what to show instead of the error")],
    examples: [["=IFERROR(1/0, 0)", 0]],
    notes: "Hides every error, including real mistakes; prefer fixing the cause where you can.",
  },
  {
    name: "AND",
    category: "Logic",
    summary: "TRUE when every condition is true.",
    args: [num("logical1", "a condition"), num("logical2", "more conditions", { optional: true, repeats: true })],
    examples: [["=AND(A1>5, A2>5)", true]],
  },
  {
    name: "OR",
    category: "Logic",
    summary: "TRUE when at least one condition is true.",
    args: [num("logical1", "a condition"), num("logical2", "more conditions", { optional: true, repeats: true })],
    examples: [["=OR(A1>15, A2>15)", true]],
  },
  {
    name: "NOT",
    category: "Logic",
    summary: "Flips TRUE and FALSE.",
    args: [num("logical", "a condition")],
    examples: [["=NOT(A1>15)", true]],
  },
  // ----------------------------------------------------------------- text
  {
    name: "LEN",
    category: "Text",
    summary: "How many characters a text has (spaces count).",
    args: [num("text", "the text or a cell")],
    examples: [["=LEN(A4)", 5]],
  },
  {
    name: "UPPER",
    category: "Text",
    summary: "The text in capitals.",
    args: [num("text", "the text or a cell")],
    examples: [["=UPPER(B1)", "NORTH"]],
  },
  {
    name: "LOWER",
    category: "Text",
    summary: "The text in lower case.",
    args: [num("text", "the text or a cell")],
    examples: [["=LOWER(B1)", "north"]],
  },
  {
    name: "TRIM",
    category: "Text",
    summary: "Removes spaces at the ends and turns runs of spaces inside into one, as Excel does.",
    args: [num("text", "the text or a cell")],
    examples: [["=TRIM(C1)", "padded text"]],
  },
  {
    name: "CONCAT",
    category: "Text",
    summary: "Joins texts (and ranges of them) into one.",
    args: [num("text1", "a text, cell or range"), num("text2", "more", { optional: true, repeats: true })],
    examples: [['=CONCAT(B1, "-", A1)', "North-10"]],
  },
  {
      name: "DATE",
      category: "Date and time",
      summary: "A date from year, month and day. Months and days past the end roll over (month 14 is February next year).",
      args: [
        {
          name: "year",
          description: "the year; 0-1899 means 1900-3799, as in Excel"
        },
        {
          name: "month",
          description: "1-12, or more or less to roll over"
        },
        {
          name: "day",
          description: "the day of the month, or more or less to roll over"
        }
      ],
      examples: [
        [
          "=DATE(2024, 1, 15)",
          45306
        ],
        [
          "=DATE(2024, 14, 1)",
          45689
        ],
        [
          "=DATE(2024, 3, 0)",
          45351
        ]
      ]
    },
    {
      name: "TIME",
      category: "Date and time",
      summary: "A time of day as a fraction of a day (12:00 is 0.5).",
      args: [
        {
          name: "hour",
          description: "0-23"
        },
        {
          name: "minute",
          description: "0-59"
        },
        {
          name: "second",
          description: "0-59"
        }
      ],
      examples: [
        [
          "=TIME(12, 0, 0)",
          0.5
        ],
        [
          "=TIME(18, 0, 0)",
          0.75
        ]
      ]
    },
    {
      name: "YEAR",
      category: "Date and time",
      summary: "The year of a date.",
      args: [
        {
          name: "date",
          description: "a date (serial number) or date text"
        }
      ],
      examples: [
        [
          "=YEAR(D1)",
          2024
        ],
        [
          "=YEAR(\"2024-03-31\")",
          2024
        ]
      ]
    },
    {
      name: "MONTH",
      category: "Date and time",
      summary: "The month of a date, 1-12.",
      args: [
        {
          name: "date",
          description: "a date"
        }
      ],
      examples: [
        [
          "=MONTH(D1)",
          1
        ],
        [
          "=MONTH(D2)",
          3
        ]
      ]
    },
    {
      name: "DAY",
      category: "Date and time",
      summary: "The day of the month of a date.",
      args: [
        {
          name: "date",
          description: "a date"
        }
      ],
      examples: [
        [
          "=DAY(D1)",
          15
        ]
      ]
    },
    {
      name: "HOUR",
      category: "Date and time",
      summary: "The hour of a time, 0-23.",
      args: [
        {
          name: "time",
          description: "a time or date-time"
        }
      ],
      examples: [
        [
          "=HOUR(0.75)",
          18
        ]
      ]
    },
    {
      name: "MINUTE",
      category: "Date and time",
      summary: "The minutes of a time, 0-59.",
      args: [
        {
          name: "time",
          description: "a time or date-time"
        }
      ],
      examples: [
        [
          "=MINUTE(\"1:45 PM\")",
          45
        ]
      ]
    },
    {
      name: "SECOND",
      category: "Date and time",
      summary: "The seconds of a time, 0-59.",
      args: [
        {
          name: "time",
          description: "a time or date-time"
        }
      ],
      examples: [
        [
          "=SECOND(TIME(1, 2, 3))",
          3
        ]
      ]
    },
    {
      name: "WEEKDAY",
      category: "Date and time",
      summary: "The day of the week as a number.",
      args: [
        {
          name: "date",
          description: "a date"
        },
        {
          name: "type",
          description: "1 (default): Sunday = 1 … Saturday = 7; 2: Monday = 1 … Sunday = 7; 3: Monday = 0 … Sunday = 6",
          optional: true
        }
      ],
      examples: [
        [
          "=WEEKDAY(D1)",
          2
        ],
        [
          "=WEEKDAY(D1, 2)",
          1
        ]
      ]
    },
    {
      name: "TODAY",
      category: "Date and time",
      summary: "Today's date.",
      args: [],
      examples: [
        [
          "=TODAY()-TODAY()",
          0
        ],
        [
          "=YEAR(TODAY())>=2024",
          true
        ]
      ],
      notes: "Updates when the sheet recalculates (any edit), not every second."
    },
    {
      name: "NOW",
      category: "Date and time",
      summary: "The date and time now.",
      args: [],
      examples: [
        [
          "=NOW()>=TODAY()",
          true
        ]
      ],
      notes: "Updates when the sheet recalculates, not continuously."
    },
    {
      name: "EDATE",
      category: "Date and time",
      summary: "The date a number of months before or after another, keeping the day (or the month's last day if it's shorter).",
      args: [
        {
          name: "start_date",
          description: "a date"
        },
        {
          name: "months",
          description: "months to add; negative goes back"
        }
      ],
      examples: [
        [
          "=EDATE(D1, 1)",
          45337
        ],
        [
          "=EDATE(\"2024-01-31\", 1)",
          45351
        ]
      ]
    },
    {
      name: "EOMONTH",
      category: "Date and time",
      summary: "The last day of the month some months before or after a date. Handy for month-end cut-offs.",
      args: [
        {
          name: "start_date",
          description: "a date"
        },
        {
          name: "months",
          description: "0 for the same month, -1 for the month before"
        }
      ],
      examples: [
        [
          "=EOMONTH(D1, 0)",
          45322
        ],
        [
          "=EOMONTH(D1, -1)",
          45291
        ]
      ]
    },
    {
      name: "DATEVALUE",
      category: "Date and time",
      summary: "The date serial of a date written as text.",
      args: [
        {
          name: "date_text",
          description: "e.g. \"2024-01-15\", \"1/15/2024\" or \"15-Jan-2024\""
        }
      ],
      examples: [
        [
          "=DATEVALUE(\"2024-01-15\")",
          45306
        ],
        [
          "=DATEVALUE(\"not a date\")",
          "#VALUE!"
        ]
      ]
    },
    {
      name: "ISERROR",
      category: "Information",
      summary: "TRUE if the value is any error (#N/A, #DIV/0!, #REF!…).",
      args: [
        {
          name: "value",
          description: "a value, cell or formula"
        }
      ],
      examples: [
        [
          "=ISERROR(1/0)",
          true
        ],
        [
          "=ISERROR(A1)",
          false
        ]
      ]
    },
    {
      name: "ISNA",
      category: "Information",
      summary: "TRUE if the value is #N/A, the 'not found' error from lookups.",
      args: [
        {
          name: "value",
          description: "a value, cell or formula"
        }
      ],
      examples: [
        [
          "=ISNA(NA())",
          true
        ],
        [
          "=ISNA(1/0)",
          false
        ]
      ]
    },
    {
      name: "ISNUMBER",
      category: "Information",
      summary: "TRUE if the value is a number (dates are numbers too).",
      args: [
        {
          name: "value",
          description: "a value, cell or formula"
        }
      ],
      examples: [
        [
          "=ISNUMBER(A1)",
          true
        ],
        [
          "=ISNUMBER(A4)",
          false
        ]
      ]
    },
    {
      name: "ISTEXT",
      category: "Information",
      summary: "TRUE if the value is text.",
      args: [
        {
          name: "value",
          description: "a value, cell or formula"
        }
      ],
      examples: [
        [
          "=ISTEXT(A4)",
          true
        ],
        [
          "=ISTEXT(A1)",
          false
        ]
      ]
    },
    {
      name: "ISLOGICAL",
      category: "Information",
      summary: "TRUE if the value is TRUE or FALSE.",
      args: [
        {
          name: "value",
          description: "a value, cell or formula"
        }
      ],
      examples: [
        [
          "=ISLOGICAL(A1>5)",
          true
        ],
        [
          "=ISLOGICAL(A1)",
          false
        ]
      ]
    },
    {
      name: "ISBLANK",
      category: "Information",
      summary: "TRUE if the cell is completely empty (a formula that shows \"\" is not blank).",
      args: [
        {
          name: "value",
          description: "a value, cell or formula"
        }
      ],
      examples: [
        [
          "=ISBLANK(A5)",
          true
        ],
        [
          "=ISBLANK(A1)",
          false
        ]
      ]
    },
    {
      name: "NA",
      category: "Information",
      summary: "The #N/A error, to mark a value as missing on purpose.",
      args: [],
      examples: [
        [
          "=ISNA(NA())",
          true
        ]
      ]
    },
];

export const FUNCTION_INFO: Readonly<Record<string, FunctionInfo>> = Object.fromEntries([...LIST, ...LIBRARY_INFO, ...SPECIAL_INFO].map((f) => [f.name, f]));

/** "SUMIF(range, criteria, [sum_range])" */
export function signature(f: FunctionInfo): string {
  const parts = f.args.map((a) => {
    const n = a.repeats ? `${a.name}, …` : a.name;
    return a.optional ? `[${n}]` : n;
  });
  return `${f.name}(${parts.join(", ")})`;
}
