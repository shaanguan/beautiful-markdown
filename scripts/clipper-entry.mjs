/** Entry for the clipper vendor IIFE — article extraction + HTML→Markdown. */
import { Readability, isProbablyReaderable } from "@mozilla/readability";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

export { Readability, isProbablyReaderable, TurndownService, gfm };
