import { performance } from "perf_hooks";
import { isMultiDbMode } from "./../config/index.js";

import {
  isDDLAllowedForSchema,
  isInsertAllowedForSchema,
  isUpdateAllowedForSchema,
  isDeleteAllowedForSchema,
} from "./permissions.js";
import { extractSchemaFromQuery, extractSchemasFromQuery, getQueryTypes } from "./utils.js";

import * as mysql2 from "mysql2/promise";
import { log } from "./../utils/index.js";
import { mcpConfig as config, MYSQL_DISABLE_READ_ONLY_TRANSACTIONS } from "./../config/index.js";

// Force read-only mode in multi-DB mode unless explicitly configured otherwise
if (isMultiDbMode && process.env.MULTI_DB_WRITE_MODE !== "true") {
  log("error", "Multi-DB mode detected - enabling read-only mode for safety");
}

// @INFO: Check if running in test mode
const isTestEnvironment = process.env.NODE_ENV === "test" || process.env.VITEST;

// @INFO: Safe way to exit process (not during tests)
function safeExit(code: number): void {
  if (!isTestEnvironment) {
    process.exit(code);
  } else {
    log("error", `[Test mode] Would have called process.exit(${code})`);
  }
}

// @INFO: Lazy load MySQL pool
let poolPromise: Promise<mysql2.Pool>;

const getPool = (): Promise<mysql2.Pool> => {
  if (!poolPromise) {
    poolPromise = new Promise<mysql2.Pool>((resolve, reject) => {
      try {
        const pool = mysql2.createPool(config.mysql);
        log("info", "MySQL pool created successfully");
        resolve(pool);
      } catch (error) {
        log("error", "Error creating MySQL pool:", error);
        reject(error);
      }
    });
  }
  return poolPromise;
};

async function executeQuery<T>(sql: string, params: string[] = []): Promise<T> {
  let connection;
  try {
    const pool = await getPool();
    connection = await pool.getConnection();
    const result = await connection.query(sql, params);
    return (Array.isArray(result) ? result[0] : result) as T;
  } catch (error) {
    log("error", "Error executing query:", error);
    throw error;
  } finally {
    if (connection) {
      connection.release();
      log("info", "Connection released");
    }
  }
}

// @INFO: New function to handle write operations
async function executeWriteQuery<T>(sql: string): Promise<T> {
  let connection;
  try {
    const pool = await getPool();
    connection = await pool.getConnection();
    log("info", "Write connection acquired");

    // Extract schema for permissions (if needed)
    const schema = extractSchemaFromQuery(sql);

    // @INFO: Begin transaction for write operation
    await connection.beginTransaction();

    try {
      // @INFO: Execute the write query
      const startTime = performance.now();
      const result = await connection.query(sql);
      const endTime = performance.now();
      const duration = endTime - startTime;
      const response = Array.isArray(result) ? result[0] : result;

      // @INFO: Commit the transaction
      await connection.commit();

      // @INFO: Format the response based on operation type
      let responseText;

      // Check the type of query
      const queryTypes = await getQueryTypes(sql);
      const isUpdateOperation = queryTypes.some((type) =>
        ["update"].includes(type),
      );
      const isInsertOperation = queryTypes.some((type) =>
        ["insert"].includes(type),
      );
      const isDeleteOperation = queryTypes.some((type) =>
        ["delete"].includes(type),
      );
      const isDDLOperation = queryTypes.some((type) =>
        ["create", "alter", "drop", "truncate"].includes(type),
      );

      // @INFO: Type assertion for ResultSetHeader which has affectedRows, insertId, etc.
      if (isInsertOperation) {
        const resultHeader = response as mysql2.ResultSetHeader;
        responseText = `Insert successful on schema '${schema || "default"}'. Affected rows: ${resultHeader.affectedRows}, Last insert ID: ${resultHeader.insertId}`;
      } else if (isUpdateOperation) {
        const resultHeader = response as mysql2.ResultSetHeader;
        responseText = `Update successful on schema '${schema || "default"}'. Affected rows: ${resultHeader.affectedRows}, Changed rows: ${resultHeader.changedRows || 0}`;
      } else if (isDeleteOperation) {
        const resultHeader = response as mysql2.ResultSetHeader;
        responseText = `Delete successful on schema '${schema || "default"}'. Affected rows: ${resultHeader.affectedRows}`;
      } else if (isDDLOperation) {
        responseText = `DDL operation successful on schema '${schema || "default"}'.`;
      } else {
        responseText = JSON.stringify(response, null, 2);
      }

      return {
        content: [
          {
            type: "text",
            text: responseText,
          },
          {
            type: "text",
            text: `Query execution time: ${duration.toFixed(2)} ms`,
          },
        ],
        isError: false,
      } as T;
    } catch (error: unknown) {
      // @INFO: Rollback on error
      log("error", "Error executing write query:", error);
      await connection.rollback();

      return {
        content: [
          {
            type: "text",
            text: `Error executing write operation: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      } as T;
    }
  } catch (error: unknown) {
    log("error", "Error in write operation transaction:", error);
    return {
      content: [
        {
          type: "text",
          text: `Database connection error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    } as T;
  } finally {
    if (connection) {
      connection.release();
      log("info", "Write connection released");
    }
  }
}

async function executeReadOnlyQuery<T>(sql: string): Promise<T> {
  let connection;
  try {
    // Check the type of query
    const queryTypes = await getQueryTypes(sql);

    // Get schema for permission checking. `schema` is used for human-readable
    // messages; `schemas` is the full set of databases the query touches and is
    // what permission decisions are based on, so a write cannot be smuggled into
    // a different database by qualifying its table name.
    const schema = extractSchemaFromQuery(sql);
    const schemas = extractSchemasFromQuery(sql);

    const isUpdateOperation = queryTypes.some((type) =>
      ["update"].includes(type),
    );
    const isInsertOperation = queryTypes.some((type) =>
      ["insert"].includes(type),
    );
    const isDeleteOperation = queryTypes.some((type) =>
      ["delete"].includes(type),
    );
    const isDDLOperation = queryTypes.some((type) =>
      ["create", "alter", "drop", "truncate"].includes(type),
    );

    // A write is only permitted if it is allowed for *every* referenced schema.
    // When no schema can be determined (e.g. multi-DB mode with an unqualified
    // table), fall back to the single resolved schema (possibly null), which
    // routes to the global permission flag. Using the raw `schemas` array here
    // would be unsafe: `[].every(...)` is vacuously true and would allow writes.
    const schemasToCheck = schemas.length > 0 ? schemas : [schema];
    const insertAllowed = schemasToCheck.every(isInsertAllowedForSchema);
    const updateAllowed = schemasToCheck.every(isUpdateAllowedForSchema);
    const deleteAllowed = schemasToCheck.every(isDeleteAllowedForSchema);
    const ddlAllowed = schemasToCheck.every(isDDLAllowedForSchema);

    // Check schema-specific permissions
    if (isInsertOperation && !insertAllowed) {
      log(
        "error",
        `INSERT operations are not allowed for schema '${schema || "default"}'. Configure SCHEMA_INSERT_PERMISSIONS.`,
      );
      return {
        content: [
          {
            type: "text",
            text: `Error: INSERT operations are not allowed for schema '${schema || "default"}'. Ask the administrator to update SCHEMA_INSERT_PERMISSIONS.`,
          },
        ],
        isError: true,
      } as T;
    }

    if (isUpdateOperation && !updateAllowed) {
      log(
        "error",
        `UPDATE operations are not allowed for schema '${schema || "default"}'. Configure SCHEMA_UPDATE_PERMISSIONS.`,
      );
      return {
        content: [
          {
            type: "text",
            text: `Error: UPDATE operations are not allowed for schema '${schema || "default"}'. Ask the administrator to update SCHEMA_UPDATE_PERMISSIONS.`,
          },
        ],
        isError: true,
      } as T;
    }

    if (isDeleteOperation && !deleteAllowed) {
      log(
        "error",
        `DELETE operations are not allowed for schema '${schema || "default"}'. Configure SCHEMA_DELETE_PERMISSIONS.`,
      );
      return {
        content: [
          {
            type: "text",
            text: `Error: DELETE operations are not allowed for schema '${schema || "default"}'. Ask the administrator to update SCHEMA_DELETE_PERMISSIONS.`,
          },
        ],
        isError: true,
      } as T;
    }

    if (isDDLOperation && !ddlAllowed) {
      log(
        "error",
        `DDL operations are not allowed for schema '${schema || "default"}'. Configure SCHEMA_DDL_PERMISSIONS.`,
      );
      return {
        content: [
          {
            type: "text",
            text: `Error: DDL operations are not allowed for schema '${schema || "default"}'. Ask the administrator to update SCHEMA_DDL_PERMISSIONS.`,
          },
        ],
        isError: true,
      } as T;
    }

    // For write operations that are allowed, use executeWriteQuery
    if (
      (isInsertOperation && insertAllowed) ||
      (isUpdateOperation && updateAllowed) ||
      (isDeleteOperation && deleteAllowed) ||
      (isDDLOperation && ddlAllowed)
    ) {
      return executeWriteQuery(sql);
    }

    // For read-only operations, continue with the original logic
    const pool = await getPool();
    connection = await pool.getConnection();
    log("info", "Read-only connection acquired");

    // Set read-only mode (unless disabled via environment variable)
    if (!MYSQL_DISABLE_READ_ONLY_TRANSACTIONS) {
      await connection.query("SET SESSION TRANSACTION READ ONLY");
    } else {
      log("info", "Read-only transactions disabled via MYSQL_DISABLE_READ_ONLY_TRANSACTIONS=true");
    }

    // Begin transaction
    await connection.beginTransaction();

    try {
      // Execute query - in multi-DB mode, we may need to handle USE statements specially
      const startTime = performance.now();
      const result = await connection.query(sql);
      const endTime = performance.now();
      const duration = endTime - startTime;
      const rows = Array.isArray(result) ? result[0] : result;

      // Rollback transaction (since it's read-only)
      await connection.rollback();

      // Reset to read-write mode (only if we set it to read-only)
      if (!MYSQL_DISABLE_READ_ONLY_TRANSACTIONS) {
        await connection.query("SET SESSION TRANSACTION READ WRITE");
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(rows, null, 2),
          },
          {
            type: "text",
            text: `Query execution time: ${duration.toFixed(2)} ms`,
          },
        ],
        isError: false,
      } as T;
    } catch (error) {
      // Rollback transaction on query error
      log("error", "Error executing read-only query:", error);
      await connection.rollback();
      throw error;
    }
  } catch (error) {
    // Ensure we rollback and reset transaction mode on any error
    log("error", "Error in read-only query transaction:", error);
    try {
      if (connection) {
        await connection.rollback();
        // Reset to read-write mode (only if we set it to read-only)
        if (!MYSQL_DISABLE_READ_ONLY_TRANSACTIONS) {
          await connection.query("SET SESSION TRANSACTION READ WRITE");
        }
      }
    } catch (cleanupError) {
      // Ignore errors during cleanup
      log("error", "Error during cleanup:", cleanupError);
    }
    throw error;
  } finally {
    if (connection) {
      connection.release();
      log("info", "Read-only connection released");
    }
  }
}

export {
  isTestEnvironment,
  safeExit,
  executeQuery,
  getPool,
  executeWriteQuery,
  executeReadOnlyQuery,
  poolPromise,
};
