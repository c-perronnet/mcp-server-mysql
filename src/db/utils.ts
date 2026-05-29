import { isMultiDbMode } from "./../config/index.js";
import { log } from "./../utils/index.js";
import SqlParser, { AST } from "node-sql-parser";

const { Parser } = SqlParser;
const parser = new Parser();

// Extract schema from SQL query
function extractSchemaFromQuery(sql: string): string | null {
  // Default schema from environment
  const defaultSchema = process.env.MYSQL_DB || null;

  // If we have a default schema and not in multi-DB mode, return it
  if (defaultSchema && !isMultiDbMode) {
    return defaultSchema;
  }

  // Try to extract schema from query

  // Case 1: USE database statement
  const useMatch = sql.match(/USE\s+`?([a-zA-Z0-9_]+)`?/i);
  if (useMatch && useMatch[1]) {
    return useMatch[1];
  }

  // Case 2: database.table notation
  const dbTableMatch = sql.match(/`?([a-zA-Z0-9_]+)`?\.`?[a-zA-Z0-9_]+`?/i);
  if (dbTableMatch && dbTableMatch[1]) {
    return dbTableMatch[1];
  }

  // Return default if we couldn't find a schema in the query
  return defaultSchema;
}

// Extract *all* schemas referenced by a query so permission checks cannot be
// bypassed by qualifying a table with a different database (e.g. while connected
// in single-DB mode). Uses the SQL AST for reliable table/db resolution and
// avoids the regex false-positives (table aliases, `table.column`) of
// extractSchemaFromQuery.
function extractSchemasFromQuery(sql: string): string[] {
  const defaultSchema = process.env.MYSQL_DB || null;
  const schemas = new Set<string>();

  // USE statements are not reported by tableList, capture them separately.
  const useMatch = sql.match(/USE\s+`?([a-zA-Z0-9_]+)`?/i);
  if (useMatch && useMatch[1]) {
    schemas.add(useMatch[1]);
  }

  try {
    // tableList returns entries formatted as "{type}::{db}::{table}".
    const tableList = parser.tableList(sql, { database: "mysql" });
    for (const entry of tableList) {
      const parts = entry.split("::");
      const db = parts[1];
      if (db && db !== "null") {
        schemas.add(db);
      }
    }
  } catch (err) {
    // Fall back to a conservative regex sweep if the AST parse fails.
    const dbTableRegex = /`?([a-zA-Z0-9_]+)`?\s*\.\s*`?[a-zA-Z0-9_]+`?/gi;
    let match: RegExpExecArray | null;
    while ((match = dbTableRegex.exec(sql)) !== null) {
      if (match[1]) {
        schemas.add(match[1]);
      }
    }
  }

  // Unqualified tables resolve to the default schema (single-DB mode).
  if (schemas.size === 0 && defaultSchema) {
    schemas.add(defaultSchema);
  }

  return [...schemas];
}

async function getQueryTypes(query: string): Promise<string[]> {
  try {
    log("info", "Parsing SQL query: ", query);
    // Parse into AST or array of ASTs - only specify the database type
    const astOrArray: AST | AST[] = parser.astify(query, { database: "mysql" });
    const statements = Array.isArray(astOrArray) ? astOrArray : [astOrArray];

    // Map each statement to its lowercased type (e.g., 'select', 'update', 'insert', 'delete', etc.)
    return statements.map((stmt) => stmt.type?.toLowerCase() ?? "unknown");
  } catch (err: any) {
    log("error", "sqlParser error, query: ", query);
    log("error", "Error parsing SQL query:", err);
    throw new Error(`Parsing failed: ${err.message}`);
  }
}

export { extractSchemaFromQuery, extractSchemasFromQuery, getQueryTypes };
