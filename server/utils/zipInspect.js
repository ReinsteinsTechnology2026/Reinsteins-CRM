const fs = require("fs");

const { LIMITS } = require("./smartSheetValidation");
const { invalid } = require("./smartSheetErrors");

// ==========================================
// ZIP INSPECTION (decompression-bomb guard for .xlsx uploads)
//
// An .xlsx is a ZIP archive. The upload limit (10 MB) bounds the COMPRESSED size only: a small file can
// declare gigabytes of XML, and parsing it would exhaust the memory of the single Node process that serves
// every tenant. This reads ONLY the archive's directory -- the end-of-central-directory record and the
// central directory (a few KB) -- and rejects the archive BEFORE any byte is inflated or parsed:
//
//   * the sum of every entry's DECLARED uncompressed size must be <= LIMITS.MAX_UNCOMPRESSED_IMPORT_BYTES
//   * at most LIMITS.MAX_ZIP_ENTRIES entries
//   * no ZIP64 archives (a workbook of at most 10 MB never needs one) and no encrypted entries
//
// The declared sizes come from the file itself, so a hostile archive can lie about them. That is why the
// parse ALSO runs in a child process with its own memory limit and a timeout (smartSheetImportRunner.js):
// this check is the cheap first line of defence, the child process is the backstop.
// ==========================================

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_MIN_LENGTH = 22;
const MAX_COMMENT_LENGTH = 0xffff;
const MAX_CENTRAL_DIRECTORY_BYTES = 4 * 1024 * 1024; // ~2000 entries with long names fit in well under 1 MB

const tooLarge = () =>
    invalid(
        "IMPORT_TOO_LARGE",
        `This workbook expands to more than ${Math.round(LIMITS.MAX_UNCOMPRESSED_IMPORT_BYTES / (1024 * 1024))} MB when opened, which is more than Smart Sheets can import safely. Remove unused data, split it into smaller workbooks, or save it again as a plain .xlsx.`
    );
const malformed = () => invalid("INVALID_XLSX", "The file could not be read as an Excel (.xlsx) workbook. It may be corrupt.");

function locateEocd(tail) {
    for (let index = tail.length - EOCD_MIN_LENGTH; index >= 0 && tail.length - index <= EOCD_MIN_LENGTH + MAX_COMMENT_LENGTH; index -= 1) {
        if (tail.readUInt32LE(index) === EOCD_SIGNATURE) return index;
    }
    throw malformed();
}

// `tail`: the last bytes of the archive (up to EOCD_MIN_LENGTH + 65535). `fileSize`: the archive's size.
// `readRange(offset, length)`: returns a Buffer (sync) of the archive's bytes -- the central directory.
function inspectArchive({ fileSize, tail, readRange }) {
    const eocdAt = locateEocd(tail);

    const totalEntries = tail.readUInt16LE(eocdAt + 10);
    const directorySize = tail.readUInt32LE(eocdAt + 12);
    const directoryOffset = tail.readUInt32LE(eocdAt + 16);

    if (totalEntries === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
        throw invalid("UNSUPPORTED_XLSX", "ZIP64 archives are not supported. Save the workbook as a regular .xlsx and try again.");
    }
    if (totalEntries === 0) throw malformed();
    if (totalEntries > LIMITS.MAX_ZIP_ENTRIES) {
        throw invalid("IMPORT_TOO_LARGE", `This workbook contains more than ${LIMITS.MAX_ZIP_ENTRIES} internal parts.`);
    }
    if (directorySize > MAX_CENTRAL_DIRECTORY_BYTES || directoryOffset + directorySize > fileSize) throw malformed();

    const directory = readRange(directoryOffset, directorySize);
    if (directory.length !== directorySize) throw malformed();

    let position = 0;
    let total = 0;
    let seen = 0;
    while (seen < totalEntries) {
        if (position + 46 > directory.length || directory.readUInt32LE(position) !== CENTRAL_SIGNATURE) throw malformed();

        const flags = directory.readUInt16LE(position + 8);
        const uncompressed = directory.readUInt32LE(position + 24);
        const nameLength = directory.readUInt16LE(position + 28);
        const extraLength = directory.readUInt16LE(position + 30);
        const commentLength = directory.readUInt16LE(position + 32);

        if (flags & 0x1) {
            throw invalid("UNSUPPORTED_XLSX", "This workbook is password-protected. Remove the password and try again.");
        }
        if (uncompressed === 0xffffffff) {
            throw invalid("UNSUPPORTED_XLSX", "ZIP64 archives are not supported. Save the workbook as a regular .xlsx and try again.");
        }

        total += uncompressed;
        if (total > LIMITS.MAX_UNCOMPRESSED_IMPORT_BYTES) throw tooLarge();

        position += 46 + nameLength + extraLength + commentLength;
        seen += 1;
    }

    return { entries: totalEntries, uncompressedBytes: total };
}

function inspectZipBuffer(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < EOCD_MIN_LENGTH) throw malformed();
    const tail = buffer.subarray(Math.max(0, buffer.length - (EOCD_MIN_LENGTH + MAX_COMMENT_LENGTH)));
    return inspectArchive({
        fileSize: buffer.length,
        tail,
        readRange: (offset, length) => buffer.subarray(offset, offset + length),
    });
}

// Reads only the tail and the central directory from disk -- never the whole file.
async function inspectZipFile(filePath) {
    const handle = await fs.promises.open(filePath, "r");
    try {
        const { size } = await handle.stat();
        if (size < EOCD_MIN_LENGTH) throw malformed();

        const tailLength = Math.min(size, EOCD_MIN_LENGTH + MAX_COMMENT_LENGTH);
        const tail = Buffer.alloc(tailLength);
        await handle.read(tail, 0, tailLength, size - tailLength);

        // inspectArchive validates the numbers; here we only need to know where the directory lives so it can
        // be read from disk (it is bounded by MAX_CENTRAL_DIRECTORY_BYTES before anything is allocated).
        const eocdAt = locateEocd(tail);
        const directorySize = tail.readUInt32LE(eocdAt + 12);
        const directoryOffset = tail.readUInt32LE(eocdAt + 16);
        let directory = Buffer.alloc(0);
        if (directorySize <= MAX_CENTRAL_DIRECTORY_BYTES && directoryOffset + directorySize <= size && directorySize !== 0xffffffff) {
            directory = Buffer.alloc(directorySize);
            await handle.read(directory, 0, directorySize, directoryOffset);
        }
        return inspectArchive({ fileSize: size, tail, readRange: () => directory });
    } finally {
        await handle.close();
    }
}

module.exports = { inspectZipBuffer, inspectZipFile };
