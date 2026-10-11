import http from "http";
import pg from "pg";
import type { Config } from "./config.js";
import { renderPageShell } from "./shell.js";
import { getUptime } from "./uptime.js";

export interface TableInfo {
  name: string;
  rowCount: number;
}

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  primaryKey: boolean;
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
    `SELECT c.column_name, c.data_type, c.is_nullable,
            (pk.column_name IS NOT NULL) AS is_primary_key
     FROM information_schema.columns c
     LEFT JOIN (
       SELECT kcu.column_name
       FROM information_schema.key_column_usage kcu
       JOIN information_schema.table_constraints tc
         ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
        AND tc.table_name = kcu.table_name
       WHERE tc.constraint_type = 'PRIMARY KEY'
         AND tc.table_schema = 'public'
         AND tc.table_name = $1
     ) pk ON pk.column_name = c.column_name
     WHERE c.table_schema = 'public' AND c.table_name = $1
     ORDER BY c.ordinal_position`,
    [tableName]
  );

  return {
    name: tableName,
    columns: result.rows.map((row) => ({
      name: row.column_name as string,
      type: row.data_type as string,
      nullable: row.is_nullable === "YES",
      primaryKey: row.is_primary_key === true,
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

const EXPLORER_HEAD = `<div class="sb-page-h" style="align-items: flex-start">
  <div>
    <h1 class="sb-h1">Database</h1>
    <p>Read-only view of every table.</p>
  </div>
  <div class="sb-db-controls">
    <div class="sb-field" style="width: 260px">
      <label for="db-table-select">Table</label>
      <div class="sb-select-wrap">
        <select id="db-table-select" class="sb-input sb-mono" disabled>
          <option value="">Choose a table...</option>
        </select>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg>
      </div>
    </div>
    <button class="sb-btn sb-btn-secondary" type="button" id="db-schema-btn" data-open-schema disabled>Schema<span class="sb-badge" style="height: 20px" id="db-schema-count" hidden></span></button>
  </div>
</div>

<div class="sb-db-body" id="db-body">
  <section class="sb-card sb-db-table-card" aria-busy="true" style="overflow: hidden">
    <div class="sb-table-wrap">
      <div class="sb-db-skel-row"><span class="sb-skel" style="width: 24px"></span><span class="sb-skel" style="width: 70%"></span><span class="sb-skel" style="width: 50%"></span></div>
      <div class="sb-db-skel-row"><span class="sb-skel" style="width: 20px"></span><span class="sb-skel" style="width: 85%"></span><span class="sb-skel" style="width: 90%"></span></div>
      <div class="sb-db-skel-row"><span class="sb-skel" style="width: 22px"></span><span class="sb-skel" style="width: 60%"></span><span class="sb-skel" style="width: 70%"></span></div>
    </div>
    <div class="sb-pager"><span>Loading tables...</span></div>
  </section>
</div>

<div class="sb-db-overlay" id="db-schema-overlay" hidden>
  <div class="sb-scrim" data-schema-close></div>
  <div class="sb-dialog sb-db-schema" role="dialog" aria-modal="true" aria-labelledby="db-schema-title">
    <div class="sb-panel-h">
      <div><span class="sb-label" id="db-schema-table"></span><h2 class="sb-h2" id="db-schema-title"></h2></div>
      <button class="sb-btn sb-btn-ghost sb-btn-icon" type="button" data-schema-close aria-label="Close schema"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"></path></svg></button>
    </div>
    <div class="sb-db-schema-scroll">
      <table class="sb-table">
        <thead><tr><th class="is-upper">Column</th><th class="is-upper">Type</th><th class="is-upper" style="width: 110px">Nullable</th></tr></thead>
        <tbody id="db-schema-rows"></tbody>
      </table>
    </div>
    <div class="sb-card-f"><span class="sb-hint">Nullable columns accept NULL. Primary keys are marked.</span><button class="sb-btn sb-btn-secondary sb-btn-sm" type="button" data-schema-close>Close</button></div>
  </div>
</div>

<div class="sb-db-overlay" id="db-picker-overlay" hidden>
  <div class="sb-scrim" data-picker-close></div>
  <div class="sb-sheet sb-db-picker" role="dialog" aria-modal="true" aria-labelledby="db-picker-title">
    <div class="sb-sheet-grip"></div>
    <div class="sb-db-sheet-h"><h2 class="sb-h2" id="db-picker-title">Choose a table</h2><button class="sb-btn sb-btn-ghost sb-btn-icon sb-btn-lg" type="button" data-picker-close aria-label="Close"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"></path></svg></button></div>
    <div class="sb-search"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-4-4"></path></svg><input class="sb-input sb-input-lg" type="search" id="db-picker-filter" placeholder="Filter tables" aria-label="Filter tables"></div>
    <div class="sb-card" style="overflow: hidden; max-height: 320px; overflow-y: auto" id="db-picker-list" role="listbox" aria-label="Tables"></div>
  </div>
</div>

<div class="sb-db-overlay" id="db-sort-overlay" hidden>
  <div class="sb-scrim" data-sort-close></div>
  <div class="sb-sheet sb-db-sort" role="dialog" aria-modal="true" aria-labelledby="db-sort-title">
    <div class="sb-sheet-grip"></div>
    <div class="sb-db-sheet-h"><h2 class="sb-h2" id="db-sort-title">Sort rows</h2><button class="sb-btn sb-btn-ghost sb-btn-icon sb-btn-lg" type="button" data-sort-close aria-label="Close"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"></path></svg></button></div>
    <div class="sb-field">
      <span class="sb-field-label">Direction</span>
      <div class="sb-seg" id="db-sort-dir" role="group" aria-label="Sort direction">
        <button type="button" data-sort-dir="asc">Ascending</button>
        <button type="button" data-sort-dir="desc">Descending</button>
        <button type="button" data-sort-dir="none">Not sorted</button>
      </div>
    </div>
    <div class="sb-label" style="padding-left:4px">Column</div>
    <div class="sb-card" style="overflow: hidden; max-height: 50vh; overflow-y: auto" id="db-sort-columns" role="listbox" aria-label="Sort column"></div>
  </div>
</div>

<script src="https://cdn.jsdelivr.net/npm/marked@15.0.12/marked.min.js" integrity="sha384-948ahk4ZmxYVYOc+rxN1H2gM1EJ2Duhp7uHtZ4WSLkV4Vtx5MUqnV+l7u9B+jFv+" crossorigin="anonymous"></script>
<script src="https://cdn.jsdelivr.net/npm/dompurify@3.3.2/dist/purify.min.js" integrity="sha384-8hAfZQ5Oqos5HLTHfR0sLvvwpcVI4fGhV+0Dj/HCcpkKaacivQs82XHmvLOnAhXn" crossorigin="anonymous"></script>`;

const EXPLORER_SCRIPT = `<script>
(function () {
  var PAGE_SIZE = 50;
  var mobileQuery = window.matchMedia("(max-width: 768px)");

  var SORT_UP = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m7 14 5-5 5 5"></path></svg>';
  var SORT_DOWN = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m7 10 5 5 5-5"></path></svg>';
  var CHEV_LEFT = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 6-6 6 6 6"></path></svg>';
  var CHEV_RIGHT = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"></path></svg>';
  var CHEV_LEFT_LG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 6-6 6 6 6"></path></svg>';
  var CHEV_RIGHT_LG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"></path></svg>';
  var CHEV_SELECT = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg>';
  var CHEV_DOWN = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m7 10 5 5 5-5"></path></svg>';
  var CHECK = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="color: var(--accent-text)"><path d="m5 12 5 5 9-10"></path></svg>';
  var TABLE_ICON = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><ellipse cx="12" cy="5" rx="8" ry="3"></ellipse><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"></path></svg>';
  var ERROR_ICON = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 8v5M12 16v.5"></path></svg>';
  var RETRY = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6"></path></svg>';
  var BACK = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 12H5M11 6l-6 6 6 6"></path></svg>';
  var CHEV_ITEM = '<svg class="sb-chev" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="margin-top: 14px"><path d="m9 6 6 6-6 6"></path></svg>';

  var state = {
    tables: [],
    table: null,
    schema: null,
    columnNames: [],
    rows: [],
    total: 0,
    offset: 0,
    orderBy: null,
    orderDirection: "asc",
    selectedIndex: -1,
    view: "loading",
    errorMessage: ""
  };
  var pickerAutoOpened = false;

  var body = document.getElementById("db-body");
  var tableSelect = document.getElementById("db-table-select");
  var schemaButton = document.getElementById("db-schema-btn");
  var schemaCount = document.getElementById("db-schema-count");
  var schemaOverlay = document.getElementById("db-schema-overlay");
  var pickerOverlay = document.getElementById("db-picker-overlay");
  var pickerFilter = document.getElementById("db-picker-filter");
  var pickerList = document.getElementById("db-picker-list");
  var sortOverlay = document.getElementById("db-sort-overlay");
  var sortColumns = document.getElementById("db-sort-columns");
  var sortDir = document.getElementById("db-sort-dir");
  var sortSheetMode = "asc";
  var shellHeader = document.querySelector(".sb-page > .sb-m-header");
  var mobileHeading = shellHeader ? shellHeader.querySelector("h1") : null;
  var originalHeading = mobileHeading ? mobileHeading.textContent : "Database";

  function esc(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function formatCount(value) {
    return String(value).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ",");
  }

  function errorText(error) {
    return error && error.message ? error.message : String(error);
  }

  function fetchJson(url) {
    return fetch(url).then(function (response) {
      return response.json().catch(function () {
        return {};
      }).then(function (data) {
        return { ok: response.ok, status: response.status, data: data };
      });
    });
  }

  function isNumericType(type) {
    return /^(smallint|integer|bigint|numeric|decimal|real|double precision|money|oid)$/.test(type);
  }

  function isDateType(type) {
    return type === "date" || type.indexOf("timestamp") === 0 || type.indexOf("time ") === 0;
  }

  function isTimeOnly(type) {
    return type.indexOf("time ") === 0;
  }

  function isJsonType(type) {
    return type === "json" || type === "jsonb";
  }

  function isTextType(type) {
    return type === "text" || type === "character varying" || type === "character" || type === "citext" || type === "name";
  }

  function shortType(type) {
    var map = {
      "timestamp without time zone": "timestamp",
      "timestamp with time zone": "timestamptz",
      "time without time zone": "time",
      "time with time zone": "timetz",
      "character varying": "varchar",
      "character": "char",
      "double precision": "double"
    };
    return map[type] || type;
  }

  function formatDate(value, type) {
    var date = new Date(value);
    if (isNaN(date.getTime())) {
      return '<span class="sb-cell-date">' + esc(String(value)) + '</span>';
    }
    var iso = date.toISOString();
    var day = iso.slice(0, 10);
    var time = iso.slice(11, 19);
    if (type === "date") {
      return '<span class="sb-cell-date">' + day + '</span>';
    }
    if (isTimeOnly(type)) {
      return '<span class="sb-cell-date">' + time + '</span>';
    }
    return '<span class="sb-cell-date">' + day + ' <span>' + time + '</span></span>';
  }

  function formatNumber(value) {
    var text = String(value);
    var match = text.match(/^(-?)(\\d+)(\\.\\d+)?$/);
    if (!match) {
      return text;
    }
    return match[1] + match[2].replace(/\\B(?=(\\d{3})+(?!\\d))/g, ",") + (match[3] || "");
  }

  function formatJson(value) {
    var raw = JSON.stringify(value);
    if (raw === undefined) {
      return "";
    }
    var marked = raw.replace(/("(?:\\\\.|[^"\\\\])*")(\\s*:)/g, "\\uE000$1\\uE001$2");
    return esc(marked).replace(/\\uE000/g, "<b>").replace(/\\uE001/g, "</b>");
  }

  function renderMarkdown(text) {
    if (typeof marked !== "undefined" && typeof DOMPurify !== "undefined") {
      try {
        return DOMPurify.sanitize(marked.parse(text));
      } catch (error) {
        return esc(text);
      }
    }
    return esc(text);
  }

  function renderMarkdownInline(text) {
    if (typeof marked !== "undefined" && typeof DOMPurify !== "undefined") {
      try {
        return DOMPurify.sanitize(marked.parseInline(text));
      } catch (error) {
        return esc(text);
      }
    }
    return esc(text);
  }

  function formatCell(value, col) {
    if (value === null || value === undefined) {
      return '<span class="sb-cell-null">NULL</span>';
    }
    if (typeof value === "string" && value.length === 0) {
      return '<span class="sb-cell-empty">empty</span>';
    }
    var type = col ? col.type : "";
    if (isNumericType(type)) {
      return '<div class="sb-cell-num">' + esc(formatNumber(value)) + '</div>';
    }
    if (isDateType(type)) {
      return formatDate(value, type);
    }
    if (isJsonType(type) || typeof value === "object") {
      return '<div class="sb-trunc sb-cell-json">' + formatJson(value) + '</div>';
    }
    if (typeof value === "boolean") {
      return '<span class="sb-mono">' + (value ? "true" : "false") + '</span>';
    }
    return '<div class="sb-trunc sb-cell-md">' + renderMarkdownInline(String(value)) + '</div>';
  }

  function panelValue(value, col) {
    if (value === null || value === undefined) {
      return '<div class="sb-pf-v"><span class="sb-cell-null">NULL</span></div>';
    }
    if (typeof value === "string" && value.length === 0) {
      return '<div class="sb-pf-v"><span class="sb-cell-empty">empty</span></div>';
    }
    var type = col ? col.type : "";
    if (isJsonType(type) || typeof value === "object") {
      return '<div class="sb-value-block">' + esc(JSON.stringify(value, null, 2)) + '</div>';
    }
    if (isDateType(type)) {
      return '<div class="sb-pf-v">' + formatDate(value, type) + '</div>';
    }
    if (isNumericType(type)) {
      return '<div class="sb-pf-v sb-mono">' + esc(formatNumber(value)) + '</div>';
    }
    if (typeof value === "boolean") {
      return '<div class="sb-pf-v sb-mono">' + (value ? "true" : "false") + '</div>';
    }
    return '<div class="sb-pf-v sb-md">' + renderMarkdown(String(value)) + '</div>';
  }

  function columnByName(name) {
    if (state.schema === null) {
      return null;
    }
    for (var i = 0; i < state.schema.columns.length; i++) {
      if (state.schema.columns[i].name === name) {
        return state.schema.columns[i];
      }
    }
    return null;
  }

  function primaryKeyIndex() {
    if (state.schema === null) {
      return -1;
    }
    for (var i = 0; i < state.schema.columns.length; i++) {
      if (state.schema.columns[i].primaryKey) {
        return i;
      }
    }
    return -1;
  }

  function firstDateIndex() {
    for (var i = 0; i < state.columnNames.length; i++) {
      var col = columnByName(state.columnNames[i]);
      if (col !== null && isDateType(col.type)) {
        return i;
      }
    }
    return -1;
  }

  function firstTextIndex() {
    for (var i = 0; i < state.columnNames.length; i++) {
      var col = columnByName(state.columnNames[i]);
      if (col !== null && isTextType(col.type)) {
        return i;
      }
    }
    return -1;
  }

  function idValue(row) {
    var index = primaryKeyIndex();
    if (index === -1 || index >= row.length) {
      index = 0;
    }
    return row[index];
  }

  function rowTitle(row) {
    var names = ["name", "title", "nickname", "subject", "slug", "path", "label"];
    for (var n = 0; n < names.length; n++) {
      for (var i = 0; i < state.columnNames.length; i++) {
        if (state.columnNames[i].toLowerCase() === names[n]) {
          var value = row[i];
          if (value !== null && value !== undefined && String(value).length > 0) {
            return String(value);
          }
        }
      }
    }
    var id = idValue(row);
    return "Row " + (id === null || id === undefined ? "" : String(id));
  }

  function columnWidth(col) {
    if (col === null) {
      return "220px";
    }
    if (isNumericType(col.type)) {
      return "110px";
    }
    if (isDateType(col.type)) {
      return "170px";
    }
    if (isJsonType(col.type)) {
      return "260px";
    }
    if (col.type === "boolean") {
      return "90px";
    }
    return "280px";
  }

  function skeletonRow() {
    return '<div class="sb-db-skel-row"><span class="sb-skel" style="width: 24px"></span><span class="sb-skel" style="width: 70%"></span><span class="sb-skel" style="width: 50%"></span></div>';
  }

  function loadingHtml() {
    return '<section class="sb-card sb-db-table-card" aria-busy="true" style="overflow: hidden">'
      + '<div class="sb-table-wrap">' + skeletonRow() + skeletonRow() + skeletonRow() + '</div>'
      + '<div class="sb-pager"><span>Loading ' + esc(state.table === null ? "tables" : state.table) + '...</span></div>'
      + '</section>';
  }

  function emptyHtml() {
    var count = state.tables.length;
    var text = count === 1 ? "1 table." : count + " tables.";
    return '<section class="sb-card"><div class="sb-state">'
      + '<div class="sb-state-icon">' + TABLE_ICON + '</div>'
      + '<strong>Choose a table</strong>'
      + '<p>' + esc(text) + ' Select one to see its rows.</p>'
      + '<div class="sb-db-mobile-only"><button class="sb-btn sb-btn-secondary" type="button" data-open-picker>Choose a table</button></div>'
      + '</div></section>';
  }

  function errorHtml() {
    var title = state.table === null ? "Could not load tables" : 'Could not load "' + esc(state.table) + '"';
    return '<section class="sb-card"><div class="sb-state is-error">'
      + '<div class="sb-state-icon">' + ERROR_ICON + '</div>'
      + '<strong>' + title + '</strong>'
      + '<p>' + esc(state.errorMessage || "The server did not answer.") + '</p>'
      + '<button class="sb-btn sb-btn-secondary sb-btn-sm" type="button" data-retry>' + RETRY + 'Try again</button>'
      + '</div></section>';
  }

  function sortHintHtml() {
    var text;
    if (state.orderBy === null) {
      text = "Not sorted";
    } else {
      var col = columnByName(state.orderBy);
      var direction;
      if (col !== null && isDateType(col.type)) {
        direction = state.orderDirection === "desc" ? "newest first" : "oldest first";
      } else {
        direction = state.orderDirection === "desc" ? "descending" : "ascending";
      }
      text = "Sorted by " + state.orderBy + ", " + direction;
    }
    return '<button class="sb-db-mobile-only sb-db-sort-hint" id="db-sort-hint" type="button" data-open-sort>' + CHEV_DOWN + esc(text) + '</button>';
  }

  function tableHeadHtml() {
    var cells = "";
    for (var i = 0; i < state.columnNames.length; i++) {
      var name = state.columnNames[i];
      var col = columnByName(name);
      var numeric = col !== null && isNumericType(col.type);
      var sortState = state.orderBy === name ? (state.orderDirection === "asc" ? "asc" : "desc") : "none";
      var aria = sortState === "asc" ? "ascending" : sortState === "desc" ? "descending" : "none";
      var buttonClass = "sb-th-sort sb-mono" + (sortState === "asc" ? " is-asc" : sortState === "desc" ? " is-desc" : "");
      cells += '<th scope="col" aria-sort="' + aria + '" style="width: ' + columnWidth(col) + (numeric ? "; text-align: right" : "") + '">'
        + '<button class="' + buttonClass + '" type="button" data-sort="' + esc(name) + '">' + esc(name)
        + '<span class="sb-sort">' + SORT_UP + SORT_DOWN + '</span></button></th>';
    }
    return cells;
  }

  function tableBodyHtml() {
    if (state.rows.length === 0) {
      return '<tr><td colspan="' + Math.max(1, state.columnNames.length) + '"><div class="sb-state" style="padding: 24px"><strong>No rows</strong></div></td></tr>';
    }
    var html = "";
    for (var i = 0; i < state.rows.length; i++) {
      var row = state.rows[i];
      var cells = "";
      for (var j = 0; j < state.columnNames.length; j++) {
        var col = columnByName(state.columnNames[j]);
        var numeric = col !== null && isNumericType(col.type);
        cells += '<td' + (numeric ? ' style="text-align: right"' : "") + '>' + formatCell(row[j], col) + '</td>';
      }
      html += '<tr tabindex="0" data-row-index="' + i + '"' + (i === state.selectedIndex ? ' class="is-selected"' : "") + '>' + cells + '</tr>';
    }
    return html;
  }

  function pagerHtml() {
    var start = state.total === 0 ? 0 : state.offset + 1;
    var end = state.offset + state.rows.length;
    var prevDisabled = state.offset === 0 ? " disabled" : "";
    var nextDisabled = state.offset + PAGE_SIZE >= state.total ? " disabled" : "";
    return '<span><span class="sb-desktop-only">Rows ' + formatCount(start) + ' to ' + formatCount(end) + ' of ' + formatCount(state.total) + ' \\u00b7 scroll sideways for all ' + state.columnNames.length + ' columns</span>'
      + '<span class="sb-mobile-only">' + formatCount(start) + ' to ' + formatCount(end) + ' of ' + formatCount(state.total) + '</span></span>'
      + '<div class="sb-pager-btns">'
      + '<button class="sb-btn sb-btn-secondary sb-btn-sm sb-db-pager-btn" type="button" data-prev aria-label="Previous page"' + prevDisabled + '>' + CHEV_LEFT + '<span class="sb-desktop-only">Previous</span></button>'
      + '<button class="sb-btn sb-btn-secondary sb-btn-sm sb-db-pager-btn" type="button" data-next aria-label="Next page"' + nextDisabled + '><span class="sb-desktop-only">Next</span>' + CHEV_RIGHT + '</button>'
      + '</div>';
  }

  function tableMinWidth() {
    var total = 0;
    for (var i = 0; i < state.columnNames.length; i++) {
      total += parseInt(columnWidth(columnByName(state.columnNames[i])), 10);
    }
    return total;
  }

  function desktopTableCardHtml() {
    return '<section class="sb-card sb-db-table-card" id="db-table-card" aria-label="' + esc(state.table) + ' rows" style="overflow: hidden">'
      + '<div class="sb-table-wrap">'
      + '<table class="sb-table is-clickable sb-db-table" style="table-layout: fixed; min-width: ' + tableMinWidth() + 'px">'
      + '<thead><tr>' + tableHeadHtml() + '</tr></thead>'
      + '<tbody>' + tableBodyHtml() + '</tbody>'
      + '</table></div>'
      + '<div class="sb-pager">' + pagerHtml() + '</div>'
      + '</section>';
  }

  function mobileRowHeading(row) {
    var parts = [];
    var id = idValue(row);
    if (id !== null && id !== undefined) {
      parts.push("#" + String(id));
    }
    var dateIndex = firstDateIndex();
    if (dateIndex !== -1) {
      var date = new Date(row[dateIndex]);
      if (!isNaN(date.getTime())) {
        var iso = date.toISOString();
        parts.push(iso.slice(0, 10) + " " + iso.slice(11, 16));
      }
    }
    return esc(parts.join(" \\u00b7 "));
  }

  function mobilePrimaryText(row) {
    var index = firstTextIndex();
    if (index === -1) {
      return "";
    }
    var value = row[index];
    if (value === null || value === undefined) {
      return '<span class="sb-cell-null">NULL</span>';
    }
    if (typeof value === "string" && value.length === 0) {
      return '<span class="sb-cell-empty">empty</span>';
    }
    return renderMarkdownInline(String(value));
  }

  function mobileShortColumns(row) {
    var parts = [];
    var skipPrimary = primaryKeyIndex();
    var skipDate = firstDateIndex();
    var skipText = firstTextIndex();
    for (var i = 0; i < state.columnNames.length && parts.length < 2; i++) {
      if (i === skipPrimary || i === skipDate || i === skipText) {
        continue;
      }
      var col = columnByName(state.columnNames[i]);
      if (col === null || isJsonType(col.type)) {
        continue;
      }
      var value = row[i];
      if (value === null || value === undefined || typeof value === "object") {
        continue;
      }
      var text = String(value);
      if (text.length > 40) {
        continue;
      }
      if (isTextType(col.type) || isDateType(col.type) || isNumericType(col.type) || col.type === "boolean") {
        parts.push(esc(text));
      }
    }
    return parts.join(" \\u00b7 ");
  }

  function mobileRowHtml(row, index) {
    var sub = mobileShortColumns(row);
    return '<button class="sb-list-item' + (index === state.selectedIndex ? " is-active" : "") + '" type="button" data-row-index="' + index + '" style="align-items: flex-start; padding: 12px 12px 12px 16px">'
      + '<span class="sb-list-item-main">'
      + '<span class="sb-mono sb-faint" style="font-size: 12px; font-weight: 400">' + mobileRowHeading(row) + '</span>'
      + '<span class="sb-trunc">' + mobilePrimaryText(row) + '</span>'
      + (sub.length > 0 ? '<span class="sb-list-item-sub sb-mono">' + sub + '</span>' : "")
      + '</span>' + CHEV_ITEM + '</button>';
  }

  function mobileListCardHtml() {
    var html = '<section class="sb-card sb-db-table-card" id="db-table-card" aria-label="' + esc(state.table) + ' rows" style="overflow: hidden">';
    if (state.rows.length === 0) {
      html += '<div class="sb-state" style="padding: 24px"><strong>No rows</strong></div>';
    } else {
      for (var i = 0; i < state.rows.length; i++) {
        html += mobileRowHtml(state.rows[i], i);
      }
    }
    html += '<div class="sb-pager">' + pagerHtml() + '</div></section>';
    return html;
  }

  function rowPanelHtml() {
    return '<aside class="sb-panel sb-db-row-panel" id="db-row-panel" aria-label="Row details" hidden>'
      + '<div class="sb-panel-h"><div><span class="sb-label" id="db-panel-label"></span><h2 class="sb-h2" id="db-panel-title"></h2></div>'
      + '<button class="sb-btn sb-btn-ghost sb-btn-icon" type="button" data-panel-close aria-label="Close row details"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"></path></svg></button></div>'
      + '<div class="sb-panel-b" id="db-panel-body"></div>'
      + '</aside>';
  }

  function dataHtml() {
    var html = "";
    html += '<div class="sb-db-mobile-bar" id="db-mobile-bar">'
      + '<button class="sb-btn sb-btn-secondary sb-btn-lg sb-db-table-btn" type="button" data-open-picker aria-label="Table: ' + esc(state.table) + ', ' + esc(formatCount(state.total)) + ' rows. Change table">'
      + '<span class="sb-db-table-btn-main"><span class="sb-mono sb-db-table-btn-name">' + esc(state.table) + '</span><span class="sb-faint sb-db-table-btn-sub">' + esc(formatCount(state.total)) + ' rows</span></span>'
      + CHEV_SELECT + '</button>'
      + '<button class="sb-btn sb-btn-secondary sb-btn-lg" type="button" data-open-schema>Schema</button>'
      + '</div>';
    html += sortHintHtml();
    html += '<div class="sb-db-layout" id="db-layout">';
    html += mobileQuery.matches ? mobileListCardHtml() : desktopTableCardHtml();
    html += rowPanelHtml();
    html += '</div>';
    return html;
  }

  function renderBody() {
    if (state.view === "empty") {
      body.innerHTML = emptyHtml();
    } else if (state.view === "loading") {
      body.innerHTML = loadingHtml();
    } else if (state.view === "error") {
      body.innerHTML = errorHtml();
    } else {
      body.innerHTML = dataHtml();
    }
  }

  function updateHeaderControls() {
    if (tableSelect !== null) {
      tableSelect.value = state.table === null ? "" : state.table;
    }
    var hasSchema = state.schema !== null;
    if (schemaButton !== null) {
      schemaButton.disabled = !hasSchema;
    }
    if (schemaCount !== null) {
      if (hasSchema) {
        schemaCount.textContent = state.schema.columns.length + " columns";
        schemaCount.hidden = false;
      } else {
        schemaCount.hidden = true;
      }
    }
  }

  function populateSelect() {
    if (tableSelect === null) {
      return;
    }
    var html = '<option value="">Choose a table...</option>';
    for (var i = 0; i < state.tables.length; i++) {
      html += '<option value="' + esc(state.tables[i].name) + '">' + esc(state.tables[i].name) + ' (' + formatCount(state.tables[i].rowCount) + ' rows)</option>';
    }
    tableSelect.innerHTML = html;
    tableSelect.disabled = false;
  }

  function updateUrl(name) {
    var url = new URL(window.location.href);
    url.searchParams.set("table", name);
    history.replaceState(null, "", url.toString());
  }

  function applyDefaultSort() {
    if (state.orderBy !== null || state.schema === null) {
      return;
    }
    for (var i = 0; i < state.schema.columns.length; i++) {
      if (isDateType(state.schema.columns[i].type)) {
        state.orderBy = state.schema.columns[i].name;
        state.orderDirection = "desc";
        return;
      }
    }
  }

  async function fetchSchema(name) {
    var result = await fetchJson("/api/explorer/tables/" + encodeURIComponent(name));
    if (!result.ok || !result.data || !Array.isArray(result.data.columns)) {
      throw new Error(result.data && result.data.error ? result.data.error : "Could not load the schema.");
    }
    return result.data;
  }

  async function loadRows() {
    try {
      var url = "/api/explorer/tables/" + encodeURIComponent(state.table) + "/rows?limit=" + PAGE_SIZE + "&offset=" + state.offset;
      if (state.orderBy !== null) {
        url += "&orderBy=" + encodeURIComponent(state.orderBy) + "&orderDirection=" + state.orderDirection;
      }
      var result = await fetchJson(url);
      if (!result.ok || !result.data || !Array.isArray(result.data.columns) || !Array.isArray(result.data.rows)) {
        state.view = "error";
        state.errorMessage = result.data && result.data.error ? result.data.error : "Could not load the rows.";
        renderBody();
        return;
      }
      state.columnNames = result.data.columns;
      state.rows = result.data.rows;
      state.total = Number(result.data.total) || 0;
      state.selectedIndex = -1;
      state.view = "data";
      renderBody();
      updateHeaderControls();
    } catch (error) {
      state.view = "error";
      state.errorMessage = errorText(error);
      renderBody();
    }
  }

  async function loadTables() {
    state.view = "loading";
    state.table = null;
    state.schema = null;
    renderBody();
    try {
      var result = await fetchJson("/api/explorer/tables");
      if (!result.ok || !Array.isArray(result.data)) {
        throw new Error(result.data && result.data.error ? result.data.error : "Could not load tables.");
      }
      state.tables = result.data;
      populateSelect();
      var requested = new URL(window.location.href).searchParams.get("table");
      var known = false;
      for (var i = 0; i < state.tables.length; i++) {
        if (state.tables[i].name === requested) {
          known = true;
        }
      }
      if (requested !== null && known) {
        await selectTable(requested);
      } else {
        state.view = "empty";
        renderBody();
        if (mobileQuery.matches && !pickerAutoOpened) {
          pickerAutoOpened = true;
          openPicker();
        }
      }
    } catch (error) {
      state.view = "error";
      state.errorMessage = errorText(error);
      renderBody();
    }
  }

  async function selectTable(name) {
    if (!name) {
      return;
    }
    state.table = name;
    state.offset = 0;
    state.orderBy = null;
    state.orderDirection = "asc";
    state.selectedIndex = -1;
    state.schema = null;
    updateUrl(name);
    updateHeaderControls();
    closePanel();
    state.view = "loading";
    renderBody();
    try {
      state.schema = await fetchSchema(name);
      applyDefaultSort();
      updateHeaderControls();
      await loadRows();
    } catch (error) {
      state.view = "error";
      state.errorMessage = errorText(error);
      renderBody();
    }
  }

  function retry() {
    if (state.table !== null) {
      void selectTable(state.table);
    } else {
      void loadTables();
    }
  }

  function cycleSort(column) {
    if (state.orderBy !== column) {
      state.orderBy = column;
      state.orderDirection = "asc";
    } else if (state.orderDirection === "asc") {
      state.orderDirection = "desc";
    } else {
      state.orderBy = null;
      state.orderDirection = "asc";
    }
    goToOffset(0);
  }

  function goToOffset(offset) {
    state.offset = Math.max(0, offset);
    state.selectedIndex = -1;
    state.view = "loading";
    renderBody();
    void loadRows();
  }

  function markSelected() {
    var items = document.querySelectorAll("[data-row-index]");
    for (var i = 0; i < items.length; i++) {
      var index = parseInt(items[i].getAttribute("data-row-index"), 10);
      if (index === state.selectedIndex) {
        items[i].classList.add("is-selected");
        items[i].classList.add("is-active");
      } else {
        items[i].classList.remove("is-selected");
        items[i].classList.remove("is-active");
      }
    }
  }

  function panelFieldsHtml(row) {
    var html = "";
    for (var i = 0; i < state.columnNames.length; i++) {
      var name = state.columnNames[i];
      var col = columnByName(name);
      var typeLabel = col === null ? "" : shortType(col.type) + (col.nullable ? ", nullable" : "");
      html += '<div class="sb-pf"><div class="sb-pf-k">' + esc(name) + ' <span class="sb-type">' + esc(typeLabel) + '</span></div>' + panelValue(row[i], col) + '</div>';
    }
    return html;
  }

  function panelNavHtml(index) {
    var newerDisabled = index <= 0;
    var olderDisabled = index >= state.rows.length - 1;
    return '<div class="sb-db-row-nav">'
      + '<button class="sb-btn sb-btn-secondary sb-btn-lg" type="button" data-row-newer' + (newerDisabled ? " disabled" : "") + '>' + CHEV_LEFT_LG + 'Newer row</button>'
      + '<button class="sb-btn sb-btn-secondary sb-btn-lg" type="button" data-row-older' + (olderDisabled ? " disabled" : "") + '>Older row' + CHEV_RIGHT_LG + '</button>'
      + '</div>';
  }

  function setTabbarVisible(visible) {
    var tabbar = document.querySelector(".sb-tabbar");
    if (tabbar !== null) {
      tabbar.hidden = !visible;
    }
  }

  function showMobileDetailHeader(row) {
    if (shellHeader === null) {
      return;
    }
    if (mobileHeading !== null) {
      mobileHeading.hidden = true;
    }
    var logo = shellHeader.querySelector(".sb-logo");
    if (logo !== null) {
      logo.hidden = true;
    }
    var pill = shellHeader.querySelector(".sb-pill");
    if (pill !== null) {
      pill.hidden = true;
    }
    var back = shellHeader.querySelector("[data-db-back]");
    if (back === null) {
      back = document.createElement("button");
      back.type = "button";
      back.className = "sb-btn sb-btn-ghost sb-btn-icon sb-btn-lg";
      back.setAttribute("data-db-back", "");
      back.setAttribute("aria-label", "Back to rows");
      back.innerHTML = BACK;
      shellHeader.insertBefore(back, shellHeader.firstChild);
    }
    var detail = shellHeader.querySelector("[data-db-detail]");
    if (detail === null) {
      detail = document.createElement("div");
      detail.setAttribute("data-db-detail", "");
      detail.style.cssText = "flex: 1; min-width: 0";
      detail.innerHTML = '<div class="sb-label" style="font-size: 11px" data-db-detail-label></div><div class="sb-trunc" style="font-weight: 600; font-size: 16px" data-db-detail-title></div>';
      shellHeader.appendChild(detail);
    }
    detail.querySelector("[data-db-detail-label]").textContent = state.table + " \\u00b7 row " + String(idValue(row));
    detail.querySelector("[data-db-detail-title]").textContent = rowTitle(row);
  }

  function resetMobileHeader() {
    if (shellHeader === null) {
      return;
    }
    if (mobileHeading !== null) {
      mobileHeading.hidden = false;
      mobileHeading.textContent = originalHeading;
    }
    var logo = shellHeader.querySelector(".sb-logo");
    if (logo !== null) {
      logo.hidden = false;
    }
    var pill = shellHeader.querySelector(".sb-pill");
    if (pill !== null) {
      pill.hidden = false;
    }
    var back = shellHeader.querySelector("[data-db-back]");
    if (back !== null) {
      back.remove();
    }
    var detail = shellHeader.querySelector("[data-db-detail]");
    if (detail !== null) {
      detail.remove();
    }
  }

  function openRow(index) {
    if (index < 0 || index >= state.rows.length) {
      return;
    }
    state.selectedIndex = index;
    markSelected();
    var row = state.rows[index];
    var panelLabel = document.getElementById("db-panel-label");
    var panelTitle = document.getElementById("db-panel-title");
    var panelBody = document.getElementById("db-panel-body");
    var panel = document.getElementById("db-row-panel");
    if (panel === null || panelBody === null) {
      return;
    }
    if (panelLabel !== null) {
      panelLabel.textContent = state.table + " \\u00b7 row " + String(idValue(row));
    }
    if (panelTitle !== null) {
      panelTitle.textContent = rowTitle(row);
    }
    panelBody.innerHTML = panelFieldsHtml(row) + panelNavHtml(index);
    panel.hidden = false;
    if (mobileQuery.matches) {
      var card = document.getElementById("db-table-card");
      if (card !== null) {
        card.hidden = true;
      }
      var bar = document.getElementById("db-mobile-bar");
      if (bar !== null) {
        bar.hidden = true;
      }
      var hint = document.getElementById("db-sort-hint");
      if (hint !== null) {
        hint.hidden = true;
      }
      showMobileDetailHeader(row);
      setTabbarVisible(false);
    } else {
      var layout = document.getElementById("db-layout");
      if (layout !== null) {
        layout.classList.add("has-panel");
      }
    }
  }

  function closePanel() {
    state.selectedIndex = -1;
    var panel = document.getElementById("db-row-panel");
    if (panel !== null) {
      panel.hidden = true;
    }
    var layout = document.getElementById("db-layout");
    if (layout !== null) {
      layout.classList.remove("has-panel");
    }
    var card = document.getElementById("db-table-card");
    if (card !== null) {
      card.hidden = false;
    }
    var bar = document.getElementById("db-mobile-bar");
    if (bar !== null) {
      bar.hidden = false;
    }
    var hint = document.getElementById("db-sort-hint");
    if (hint !== null) {
      hint.hidden = false;
    }
    if (mobileQuery.matches) {
      resetMobileHeader();
      setTabbarVisible(true);
    }
    markSelected();
  }

  function openSchema() {
    if (state.schema === null) {
      return;
    }
    renderSchemaDialog();
    schemaOverlay.hidden = false;
  }

  function closeSchema() {
    if (schemaOverlay !== null) {
      schemaOverlay.hidden = true;
    }
  }

  function renderSchemaDialog() {
    if (state.schema === null) {
      return;
    }
    var tableLabel = document.getElementById("db-schema-table");
    var title = document.getElementById("db-schema-title");
    var rows = document.getElementById("db-schema-rows");
    if (tableLabel === null || title === null || rows === null) {
      return;
    }
    tableLabel.textContent = state.schema.name;
    title.textContent = "Schema \\u00b7 " + state.schema.columns.length + " columns";
    var html = "";
    for (var i = 0; i < state.schema.columns.length; i++) {
      var col = state.schema.columns[i];
      var name = esc(col.name);
      if (col.primaryKey) {
        name += ' <span class="sb-badge" style="margin-left: 6px">primary key</span>';
      }
      var nullable = col.nullable
        ? '<span class="sb-status is-warn sb-small" style="font-size: 13px">Yes</span>'
        : '<span class="sb-muted">No</span>';
      html += '<tr><td class="sb-mono">' + name + '</td><td class="sb-mono sb-muted">' + esc(shortType(col.type)) + '</td><td>' + nullable + '</td></tr>';
    }
    rows.innerHTML = html;
  }

  function renderSortSheet() {
    if (sortDir !== null) {
      var buttons = sortDir.querySelectorAll("button");
      for (var i = 0; i < buttons.length; i++) {
        if (buttons[i].getAttribute("data-sort-dir") === sortSheetMode) {
          buttons[i].classList.add("is-active");
        } else {
          buttons[i].classList.remove("is-active");
        }
      }
    }
    if (sortColumns === null || state.schema === null) {
      return;
    }
    var html = "";
    for (var j = 0; j < state.schema.columns.length; j++) {
      var name = state.schema.columns[j].name;
      var isActive = name === state.orderBy;
      html += '<button class="sb-list-item' + (isActive ? " is-active" : "") + '" type="button" role="option" aria-selected="' + (isActive ? "true" : "false") + '" data-sort-column="' + esc(name) + '">'
        + '<span class="sb-mono" style="flex: 1">' + esc(name) + '</span>'
        + (isActive ? CHECK : "")
        + '</button>';
    }
    sortColumns.innerHTML = html;
  }

  function openSortSheet() {
    if (sortOverlay === null) {
      return;
    }
    sortSheetMode = state.orderBy === null ? "none" : state.orderDirection;
    renderSortSheet();
    sortOverlay.hidden = false;
  }

  function closeSortSheet() {
    if (sortOverlay !== null) {
      sortOverlay.hidden = true;
    }
  }

  function applySort(column, direction) {
    if (column === null || direction === "none") {
      state.orderBy = null;
      state.orderDirection = "asc";
    } else {
      state.orderBy = column;
      state.orderDirection = direction === "desc" ? "desc" : "asc";
    }
    closeSortSheet();
    goToOffset(0);
  }

  function openPicker() {
    if (pickerOverlay === null) {
      return;
    }
    renderPickerList("");
    if (pickerFilter !== null) {
      pickerFilter.value = "";
    }
    pickerOverlay.hidden = false;
    if (pickerFilter !== null) {
      pickerFilter.focus();
    }
  }

  function closePicker() {
    if (pickerOverlay !== null) {
      pickerOverlay.hidden = true;
    }
  }

  function renderPickerList(filter) {
    if (pickerList === null) {
      return;
    }
    var query = (filter || "").toLowerCase();
    var html = "";
    var shown = 0;
    for (var i = 0; i < state.tables.length; i++) {
      var table = state.tables[i];
      if (query && table.name.toLowerCase().indexOf(query) === -1) {
        continue;
      }
      shown++;
      var isActive = table.name === state.table;
      html += '<button class="sb-list-item' + (isActive ? " is-active" : "") + '" type="button" role="option" aria-selected="' + (isActive ? "true" : "false") + '" data-table="' + esc(table.name) + '">'
        + '<span class="sb-mono" style="flex: 1">' + esc(table.name) + '</span>'
        + '<span class="sb-muted sb-small sb-num">' + formatCount(table.rowCount) + ' rows</span>'
        + (isActive ? CHECK : "")
        + '</button>';
    }
    if (shown === 0) {
      html = '<div class="sb-state" style="padding: 24px"><strong>No matching tables</strong></div>';
    }
    pickerList.innerHTML = html;
  }

  document.addEventListener("click", function (event) {
    var target = event.target;
    if (!target || !target.closest) {
      return;
    }
    if (target.closest("[data-open-picker]")) {
      openPicker();
      return;
    }
    if (target.closest("[data-open-schema]")) {
      openSchema();
      return;
    }
    if (target.closest("[data-open-sort]")) {
      openSortSheet();
      return;
    }
    if (target.closest("[data-sort-close]")) {
      closeSortSheet();
      return;
    }
    var sortDirButton = target.closest("[data-sort-dir]");
    if (sortDirButton !== null) {
      var chosenDirection = sortDirButton.getAttribute("data-sort-dir");
      if (chosenDirection === "none") {
        applySort(null, "none");
        return;
      }
      if (state.orderBy !== null) {
        applySort(state.orderBy, chosenDirection);
        return;
      }
      sortSheetMode = chosenDirection;
      renderSortSheet();
      return;
    }
    var sortColumnButton = target.closest("[data-sort-column]");
    if (sortColumnButton !== null) {
      applySort(sortColumnButton.getAttribute("data-sort-column"), sortSheetMode === "desc" ? "desc" : "asc");
      return;
    }
    if (target.closest("[data-schema-close]")) {
      closeSchema();
      return;
    }
    if (target.closest("[data-picker-close]")) {
      closePicker();
      return;
    }
    if (target.closest("[data-panel-close]")) {
      closePanel();
      return;
    }
    if (target.closest("[data-retry]")) {
      retry();
      return;
    }
    if (target.closest("[data-prev]")) {
      goToOffset(state.offset - PAGE_SIZE);
      return;
    }
    if (target.closest("[data-next]")) {
      goToOffset(state.offset + PAGE_SIZE);
      return;
    }
    var sortButton = target.closest("[data-sort]");
    if (sortButton !== null) {
      cycleSort(sortButton.getAttribute("data-sort"));
      return;
    }
    var tableOption = target.closest("[data-table]");
    if (tableOption !== null) {
      closePicker();
      void selectTable(tableOption.getAttribute("data-table"));
      return;
    }
    if (target.closest("[data-db-back]")) {
      closePanel();
      return;
    }
    var newer = target.closest("[data-row-newer]");
    if (newer !== null && !newer.disabled) {
      openRow(state.selectedIndex - 1);
      return;
    }
    var older = target.closest("[data-row-older]");
    if (older !== null && !older.disabled) {
      openRow(state.selectedIndex + 1);
      return;
    }
    var rowItem = target.closest("[data-row-index]");
    if (rowItem !== null) {
      openRow(parseInt(rowItem.getAttribute("data-row-index"), 10));
      return;
    }
  });

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") {
      if (schemaOverlay !== null && !schemaOverlay.hidden) {
        closeSchema();
        return;
      }
      if (pickerOverlay !== null && !pickerOverlay.hidden) {
        closePicker();
        return;
      }
      if (sortOverlay !== null && !sortOverlay.hidden) {
        closeSortSheet();
        return;
      }
      if (state.selectedIndex !== -1) {
        closePanel();
        return;
      }
    }
    if (event.key === "Enter" && event.target && event.target.matches && event.target.matches("tr[data-row-index]")) {
      event.preventDefault();
      openRow(parseInt(event.target.getAttribute("data-row-index"), 10));
    }
  });

  if (tableSelect !== null) {
    tableSelect.addEventListener("change", function () {
      if (tableSelect.value) {
        void selectTable(tableSelect.value);
      }
    });
  }

  if (pickerFilter !== null) {
    pickerFilter.addEventListener("input", function () {
      renderPickerList(pickerFilter.value);
    });
  }

  // The layout is chosen at render time from the media query, so a breakpoint
  // change must reset the mobile-only state and redraw the data we already have.
  function handleLayoutChange() {
    closeSchema();
    closePicker();
    closeSortSheet();
    closePanel();
    state.selectedIndex = -1;
    resetMobileHeader();
    setTabbarVisible(true);
    renderBody();
    updateHeaderControls();
  }

  if (mobileQuery.addEventListener) {
    mobileQuery.addEventListener("change", handleLayoutChange);
  }

  void loadTables();
})();
</script>`;

function buildExplorerPage(config: Config): string {
  return renderPageShell({
    title: "Database",
    content: EXPLORER_HEAD + EXPLORER_SCRIPT,
    nav: { active: "database", model: config.model, uptime: getUptime() },
  });
}

export function serveExplorerPage(response: http.ServerResponse, config: Config): void {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(buildExplorerPage(config));
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
