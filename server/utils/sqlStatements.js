// ==========================================
// SQL STATEMENT SPLITTER (schema files)
//
// Splits a schema file into single statements for drivers that run one statement per query. The tenant provisioner used a plain
// split on ";", which is only correct while no statement contains a semicolon of its own. Trigger/function bodies (ZioVault's
// offboarding trigger) do, so this splitter understands:
//   * whole-line "--" comments (dropped, exactly as before),
//   * single-quoted string literals ('...' with '' as an escaped quote),
//   * dollar-quoted bodies ($$ ... $$ and $tag$ ... $tag$).
// For a file without those constructs it returns exactly what the old "strip comment lines, split on ;" produced
// (_test_ziovault_schema.js proves this against the current tenant schema).
// ==========================================

function splitSqlStatements(raw) {
    const text = String(raw)
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n");

    const statements = [];
    let current = "";
    let inString = false;
    let dollarTag = null;

    for (let i = 0; i < text.length; i += 1) {
        const char = text[i];

        if (dollarTag) {
            if (text.startsWith(dollarTag, i)) {
                current += dollarTag;
                i += dollarTag.length - 1;
                dollarTag = null;
            } else {
                current += char;
            }
            continue;
        }

        if (inString) {
            current += char;
            if (char === "'") {
                if (text[i + 1] === "'") {
                    current += "'";
                    i += 1;
                } else {
                    inString = false;
                }
            }
            continue;
        }

        if (char === "'") {
            inString = true;
            current += char;
            continue;
        }

        if (char === "$") {
            const match = /^\$[A-Za-z_]*\$/.exec(text.slice(i, i + 64));
            if (match) {
                dollarTag = match[0];
                current += dollarTag;
                i += dollarTag.length - 1;
                continue;
            }
        }

        if (char === ";") {
            statements.push(current);
            current = "";
            continue;
        }

        current += char;
    }

    statements.push(current);
    return statements.map((statement) => statement.trim()).filter((statement) => statement.length > 0);
}

module.exports = { splitSqlStatements };
