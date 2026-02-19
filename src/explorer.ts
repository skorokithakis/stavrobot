import http from "http";
import pg from "pg";

export interface TableInfo {
  name: string;
  rowCount: number;
}

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
}

export interface TableSchema {
  name: string;
  columns: ColumnInfo[];
}

export interface TableRows {
  columns: string[];
  rows: unknown[][];
  total: number;
  limit: number;
  offset: number;
}

export async function listTables(pool: pg.Pool): Promise<TableInfo[]> {
  const result = await pool.query(`
    SELECT 
      t.table_name,
      COALESCE(s.n_live_tup, 0) AS row_count
    FROM information_schema.tables t
    LEFT JOIN pg_stat_user_tables s ON s.relname = t.table_name
    WHERE t.table_schema = 'public'
      AND t.table_type = 'BASE TABLE'
    ORDER BY t.table_name
  `);

  return result.rows.map((row) => ({
    name: row.table_name as string,
    rowCount: Number(row.row_count),
  }));
}

export async function getTableSchema(pool: pg.Pool, tableName: string): Promise<TableSchema | null> {
  // Validate that the table exists to prevent SQL injection via table name.
  const tableCheck = await pool.query(
    `SELECT 1 FROM information_schema.tables 
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name = $1`,
    [tableName]
  );

  if (tableCheck.rows.length === 0) {
    return null;
  }

  const result = await pool.query(
    `SELECT column_name, data_type, is_nullable
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
     ORDER BY ordinal_position`,
    [tableName]
  );

  return {
    name: tableName,
    columns: result.rows.map((row) => ({
      name: row.column_name as string,
      type: row.data_type as string,
      nullable: row.is_nullable === "YES",
    })),
  };
}

export async function getTableRows(
  pool: pg.Pool,
  tableName: string,
  limit: number,
  offset: number,
  orderBy: string | null,
  orderDirection: "asc" | "desc"
): Promise<TableRows | null> {
  // Validate that the table exists to prevent SQL injection via table name.
  const tableCheck = await pool.query(
    `SELECT 1 FROM information_schema.tables 
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name = $1`,
    [tableName]
  );

  if (tableCheck.rows.length === 0) {
    return null;
  }

  // Get column names for consistent ordering.
  const columnsResult = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
     ORDER BY ordinal_position`,
    [tableName]
  );
  const columns = columnsResult.rows.map((row) => row.column_name as string);

  // Validate orderBy column to prevent SQL injection.
  let orderClause = "ORDER BY 1";
  if (orderBy !== null && columns.includes(orderBy)) {
    const direction = orderDirection === "desc" ? "DESC" : "ASC";
    orderClause = `ORDER BY "${orderBy}" ${direction}`;
  }

  // Get total row count.
  const countResult = await pool.query(
    `SELECT COUNT(*) as total FROM "${tableName}"`
  );
  const total = Number(countResult.rows[0].total);

  // Get rows with limit and offset. Table name is safe because we validated it above.
  const rowsResult = await pool.query(
    `SELECT * FROM "${tableName}" ${orderClause} LIMIT $1 OFFSET $2`,
    [limit, offset]
  );

  // Convert rows to arrays in column order.
  const rows = rowsResult.rows.map((row) =>
    columns.map((col) => row[col])
  );

  return { columns, rows, total, limit, offset };
}

const EXPLORER_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Database explorer</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      display: flex;
      height: 100vh;
      color: #1a1a1a;
      background: #f5f5f5;
    }
    #sidebar {
      width: 240px;
      background: #fff;
      border-right: 1px solid #ddd;
      overflow-y: auto;
      padding: 16px 0;
    }
    #sidebar h2 {
      font-size: 14px;
      font-weight: 600;
      color: #666;
      padding: 0 16px 12px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .table-item {
      display: flex;
      justify-content: space-between;
      padding: 10px 16px;
      cursor: pointer;
      border-left: 3px solid transparent;
    }
    .table-item:hover { background: #f5f5f5; }
    .table-item.selected {
      background: #fff7ed;
      border-left-color: #d97706;
    }
    .table-name { font-weight: 500; }
    .row-count { color: #999; font-size: 13px; }
    #main {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    #header {
      padding: 20px 24px;
      background: #fff;
      border-bottom: 1px solid #ddd;
    }
    #header h1 {
      font-size: 20px;
      font-weight: 600;
      margin-bottom: 8px;
    }
    #schema {
      font-size: 13px;
      color: #666;
      margin-top: 8px;
    }
    #schema summary {
      cursor: pointer;
      color: #888;
      font-size: 12px;
      user-select: none;
    }
    #schema summary:hover { color: #666; }
    #schema-list {
      margin-top: 8px;
      padding-left: 4px;
    }
    .schema-row {
      padding: 3px 0;
    }
    .col-name { color: #1a1a1a; font-weight: 500; }
    .col-type { color: #888; margin-left: 8px; }
    .col-nullable { color: #aaa; font-style: italic; margin-left: 8px; }
    #content {
      flex: 1;
      overflow: auto;
      padding: 0;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
      background: #fff;
    }
    th, td {
      text-align: left;
      padding: 10px 12px;
      border-bottom: 1px solid #eee;
      max-width: 300px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    th {
      background: #fafafa;
      font-weight: 600;
      position: sticky;
      top: 0;
      border-bottom: 2px solid #ddd;
      cursor: pointer;
      user-select: none;
    }
    th:hover { background: #f0f0f0; }
    th .sort-indicator { margin-left: 4px; color: #999; }
    tbody tr { cursor: pointer; }
    tbody tr:hover td { background: #fafafa; }
    tbody tr.expanded td {
      white-space: pre-wrap;
      word-break: break-word;
      max-width: none;
      background: #fffbeb;
    }
    tbody tr.expanded:hover td { background: #fff7dc; }
    #pagination {
      padding: 12px 24px;
      background: #fff;
      border-top: 1px solid #ddd;
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 13px;
    }
    #pagination button {
      padding: 6px 12px;
      font-size: 13px;
      cursor: pointer;
      background: #fff;
      border: 1px solid #ddd;
      border-radius: 4px;
      margin-left: 8px;
    }
    #pagination button:hover:not(:disabled) { background: #f5f5f5; }
    #pagination button:disabled { opacity: 0.5; cursor: default; }
    #empty {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: #999;
      font-size: 15px;
    }
    .null-value { color: #aaa; font-style: italic; }
    .json-value { font-family: monospace; font-size: 12px; }
  </style>
</head>
<body>
  <div id="sidebar">
    <h2>Tables</h2>
    <div id="table-list"></div>
  </div>
  <div id="main">
    <div id="empty">Select a table to view its contents</div>
  </div>

  <script>
    const PAGE_SIZE = 50;
    let currentTable = null;
    let currentOffset = 0;
    let currentOrderBy = null;
    let currentOrderDirection = "asc";

    async function loadTables() {
      const response = await fetch("/api/explorer/tables");
      const tables = await response.json();
      const list = document.getElementById("table-list");
      list.innerHTML = "";
      for (const table of tables) {
        const item = document.createElement("div");
        item.className = "table-item";
        item.innerHTML = \`
          <span class="table-name">\${escapeHtml(table.name)}</span>
          <span class="row-count">\${table.rowCount}</span>
        \`;
        item.onclick = () => selectTable(table.name);
        list.appendChild(item);
      }
    }

    async function selectTable(tableName) {
      currentTable = tableName;
      currentOffset = 0;
      currentOrderBy = null;
      currentOrderDirection = "asc";

      document.querySelectorAll(".table-item").forEach((item, index) => {
        const name = item.querySelector(".table-name").textContent;
        item.classList.toggle("selected", name === tableName);
      });

      await loadTableData();
    }

    function sortByColumn(columnName) {
      if (currentOrderBy === columnName) {
        currentOrderDirection = currentOrderDirection === "asc" ? "desc" : "asc";
      } else {
        currentOrderBy = columnName;
        currentOrderDirection = "asc";
      }
      currentOffset = 0;
      loadTableData();
    }

    async function loadTableData() {
      if (!currentTable) return;

      let rowsUrl = \`/api/explorer/tables/\${encodeURIComponent(currentTable)}/rows?limit=\${PAGE_SIZE}&offset=\${currentOffset}\`;
      if (currentOrderBy) {
        rowsUrl += \`&orderBy=\${encodeURIComponent(currentOrderBy)}&orderDirection=\${currentOrderDirection}\`;
      }

      const [schemaResponse, rowsResponse] = await Promise.all([
        fetch(\`/api/explorer/tables/\${encodeURIComponent(currentTable)}\`),
        fetch(rowsUrl)
      ]);

      const schema = await schemaResponse.json();
      const data = await rowsResponse.json();

      const main = document.getElementById("main");
      main.innerHTML = \`
        <div id="header">
          <h1>\${escapeHtml(currentTable)}</h1>
          <div id="schema"></div>
        </div>
        <div id="content">
          <table>
            <thead><tr id="table-header"></tr></thead>
            <tbody id="table-body"></tbody>
          </table>
        </div>
        <div id="pagination">
          <span id="page-info"></span>
          <div>
            <button id="prev-btn" onclick="prevPage()">Previous</button>
            <button id="next-btn" onclick="nextPage()">Next</button>
          </div>
        </div>
      \`;

      const schemaEl = document.getElementById("schema");
      schemaEl.innerHTML = \`
        <details>
          <summary>Schema (\${schema.columns.length} columns)</summary>
          <div id="schema-list">
            \${schema.columns.map(col => \`
              <div class="schema-row">
                <span class="col-name">\${escapeHtml(col.name)}</span>
                <span class="col-type">\${escapeHtml(col.type)}</span>
                \${col.nullable ? '<span class="col-nullable">nullable</span>' : ""}
              </div>
            \`).join("")}
          </div>
        </details>
      \`;

      const headerEl = document.getElementById("table-header");
      headerEl.innerHTML = data.columns.map(col => {
        let indicator = "";
        if (currentOrderBy === col) {
          indicator = currentOrderDirection === "asc" ? " \\u25B2" : " \\u25BC";
        }
        return \`<th onclick="sortByColumn('\${escapeHtml(col)}')">\${escapeHtml(col)}<span class="sort-indicator">\${indicator}</span></th>\`;
      }).join("");

      const bodyEl = document.getElementById("table-body");
      bodyEl.innerHTML = data.rows.map(row => \`
        <tr onclick="toggleRowExpand(this)">\${row.map(cell => \`<td>\${formatCell(cell)}</td>\`).join("")}</tr>
      \`).join("");

      const start = currentOffset + 1;
      const end = currentOffset + data.rows.length;
      document.getElementById("page-info").textContent = \`Showing \${start}-\${end} of \${data.total}\`;
      document.getElementById("prev-btn").disabled = currentOffset === 0;
      document.getElementById("next-btn").disabled = currentOffset + PAGE_SIZE >= data.total;
    }

    function prevPage() {
      if (currentOffset > 0) {
        currentOffset = Math.max(0, currentOffset - PAGE_SIZE);
        loadTableData();
      }
    }

    function nextPage() {
      currentOffset += PAGE_SIZE;
      loadTableData();
    }

    function toggleRowExpand(row) {
      row.classList.toggle("expanded");
    }

    function escapeHtml(text) {
      const div = document.createElement("div");
      div.textContent = text;
      return div.innerHTML;
    }

    function formatCell(value) {
      if (value === null) {
        return '<span class="null-value">null</span>';
      }
      if (typeof value === "object") {
        return '<span class="json-value">' + escapeHtml(JSON.stringify(value)) + '</span>';
      }
      return escapeHtml(String(value));
    }

    loadTables();
  </script>
</body>
</html>`;

export function serveExplorerPage(response: http.ServerResponse): void {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(EXPLORER_PAGE_HTML);
}

export async function handleTablesRequest(
  response: http.ServerResponse,
  pool: pg.Pool
): Promise<void> {
  const tables = await listTables(pool);
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify(tables));
}

export async function handleTableSchemaRequest(
  response: http.ServerResponse,
  pool: pg.Pool,
  tableName: string
): Promise<void> {
  const schema = await getTableSchema(pool, tableName);
  if (schema === null) {
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "Table not found" }));
    return;
  }
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify(schema));
}

export async function handleTableRowsRequest(
  response: http.ServerResponse,
  pool: pg.Pool,
  tableName: string,
  searchParams: URLSearchParams
): Promise<void> {
  const limit = Math.min(100, Math.max(1, parseInt(searchParams.get("limit") || "50", 10)));
  const offset = Math.max(0, parseInt(searchParams.get("offset") || "0", 10));
  const orderBy = searchParams.get("orderBy");
  const orderDirection = searchParams.get("orderDirection") === "desc" ? "desc" : "asc";

  const rows = await getTableRows(pool, tableName, limit, offset, orderBy, orderDirection);
  if (rows === null) {
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "Table not found" }));
    return;
  }
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify(rows));
}
