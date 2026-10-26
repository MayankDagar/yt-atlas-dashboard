export type ChannelImportRow = {
  channelName: string;
  youtubeChannelId: string;
  category: string;
  state: string;
  region?: string;
  district?: string;
  emails?: string;
  phones?: string;
  contact?: string;
  socialLinks?: string;
  websites?: string;
};

type ZipEntry = { method: number; compressedSize: number; uncompressedSize: number; localOffset: number };

function columnIndex(address: string): number {
  const letters = address.match(/^[A-Z]+/i)?.[0]?.toUpperCase() || "A";
  let value = 0;
  for (const letter of letters) value = value * 26 + letter.charCodeAt(0) - 64;
  return value - 1;
}

function findZipEntries(bytes: Uint8Array): Map<string, ZipEntry> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let endOffset = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65_557); offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) throw new Error("This file is not a valid .xlsx workbook.");

  const entryCount = view.getUint16(endOffset + 10, true);
  if (entryCount > 5000) throw new Error("This workbook contains too many internal files.");
  let offset = view.getUint32(endOffset + 16, true);
  const entries = new Map<string, ZipEntry>();
  const decoder = new TextDecoder();
  for (let index = 0; index < entryCount; index += 1) {
    if (offset < 0 || offset + 46 > bytes.length) throw new Error("The Excel workbook could not be read.");
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error("The Excel workbook could not be read.");
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    if (uncompressedSize > 20 * 1024 * 1024 || localOffset + 30 > bytes.length || offset + 46 + nameLength + extraLength + commentLength > bytes.length) {
      throw new Error("This workbook contains an oversized or invalid internal file.");
    }
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    entries.set(name, { method, compressedSize, uncompressedSize, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function readZipEntry(bytes: Uint8Array, entry?: ZipEntry): Promise<string | null> {
  if (!entry) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const offset = entry.localOffset;
  if (view.getUint32(offset, true) !== 0x04034b50) throw new Error("An Excel workbook file could not be opened.");
  const nameLength = view.getUint16(offset + 26, true);
  const extraLength = view.getUint16(offset + 28, true);
  const dataOffset = offset + 30 + nameLength + extraLength;
  if (dataOffset + entry.compressedSize > bytes.length || entry.uncompressedSize > 20 * 1024 * 1024) {
    throw new Error("The Excel workbook contains an invalid or oversized file entry.");
  }
  const compressed = bytes.slice(dataOffset, dataOffset + entry.compressedSize);
  let contents: Uint8Array;
  if (entry.method === 0) {
    contents = compressed;
  } else if (entry.method === 8) {
    try {
      const stream = new Blob([compressed.buffer as ArrayBuffer]).stream()
        .pipeThrough(new DecompressionStream("deflate-raw" as CompressionFormat));
      const reader = stream.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 20 * 1024 * 1024 || size > entry.uncompressedSize + 1024) {
          await reader.cancel();
          throw new Error("The expanded workbook entry is too large.");
        }
        chunks.push(value);
      }
      contents = new Uint8Array(size);
      let cursor = 0;
      for (const chunk of chunks) { contents.set(chunk, cursor); cursor += chunk.byteLength; }
    } catch {
      throw new Error("This browser could not decompress the Excel workbook. Save it as .csv and import it again.");
    }
  } else {
    throw new Error("This Excel workbook uses an unsupported compression format.");
  }
  return new TextDecoder("utf-8").decode(contents);
}

function xmlDocument(source: string): XMLDocument {
  const document = new DOMParser().parseFromString(source, "application/xml");
  if (document.querySelector("parsererror")) throw new Error("The Excel workbook contains invalid worksheet data.");
  return document;
}

function normalizeHeader(value: string): string {
  return value.normalize("NFKD").toLocaleLowerCase().replace(/[^a-z0-9]/g, "");
}

function findStateColumn(header: string[]): number {
  const stateAliases = new Set([
    "state",
    "statename",
    "stateut",
    "stateorut",
    "ut",
    "utname",
    "unionterritory",
    "unionterritoryname",
  ]);
  return header.findIndex((value) => {
    const normalized = normalizeHeader(value);
    return stateAliases.has(normalized) || normalized.includes("state");
  });
}

function parseContactCell(value: string) {
  const result = { emails: [] as string[], phones: [] as string[], socialLinks: [] as string[], websites: [] as string[] };
  const segments = value.split(/[\n;,|]+/).map((item) => item.trim()).filter(Boolean);
  const emailPattern = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
  const urlPattern = /(?:https?:\/\/|www\.)[^\s<>]+|\b(?:[a-z0-9-]+\.)+(?:com|in|org|net|co|io|tv|me|gov|edu)(?:\/[^\s<>]*)?/gi;
  const socialDomains = ["instagram", "facebook", "twitter", "x.com", "tiktok", "linkedin", "youtube", "youtu.be", "telegram", "whatsapp", "snapchat", "threads"];
  for (const segment of segments) {
    for (const email of segment.match(emailPattern) || []) result.emails.push(email);
    const label = segment.match(/^\s*([^:–-]{2,30})\s*[:–-]/)?.[1]?.trim() || "";
    const urls = segment.match(urlPattern) || [];
    for (const rawUrl of urls) {
      const url = rawUrl.replace(/[.)]+$/, "");
      const lower = `${label} ${url}`.toLocaleLowerCase();
      if (socialDomains.some((domain) => lower.includes(domain))) result.socialLinks.push(`${label || "Social link"} | ${url}`);
      else result.websites.push(`${label || "Website"} | ${url}`);
    }
    const remainder = segment.replace(emailPattern, "").replace(urlPattern, "").replace(/^\s*(?:email|e-mail|phone|mobile|contact|whatsapp|call)\s*[:–-]?\s*/i, "");
    const digits = remainder.replace(/\D/g, "");
    if (digits.length >= 7 && digits.length <= 15) {
      const phone = remainder.match(/\+?\d[\d ()-]{5,}\d/)?.[0]?.trim();
      if (phone) result.phones.push(phone);
    }
  }
  return result;
}

function rowsToChannels(grid: string[][]): ChannelImportRow[] {
  const header = grid[0] || [];
  const findColumn = (names: string[]) => header.findIndex((value) => names.includes(normalizeHeader(value)));
  const columns = {
    channelName: findColumn(["channelname", "name", "youtubechannelname"]),
    youtubeChannelId: findColumn(["channelid", "youtubechannelid", "youtubeid"]),
    category: findColumn(["category", "channelcategory"]),
    state: findStateColumn(header),
    region: findColumn(["regionalarea", "regional", "region", "area"]),
    district: findColumn(["district", "districtname"]),
    emails: findColumn(["email", "emails", "emailaddress", "emailaddresses"]),
    phones: findColumn(["phone", "phones", "phonenumber", "phonenumbers", "mobile", "mobilenumber"]),
    contact: findColumn(["contact", "contacts", "contactdetails", "contactinformation"]),
    socialLinks: findColumn(["social", "sociallink", "sociallinks", "socialprofile", "socialprofiles"]),
    websites: findColumn(["website", "websites", "websiteurl", "websitelinks"]),
  };
  const required = [
    ["Channel Name", columns.channelName],
    ["Channel ID", columns.youtubeChannelId],
    ["Category", columns.category],
  ] as const;
  const missing = required.filter(([, index]) => index < 0).map(([label]) => label);
  if (missing.length) throw new Error(`Add these required column headings to the first sheet: ${missing.join(", ")}.`);

  return grid.slice(1).flatMap((row) => {
    if (!row.some((value) => value.trim())) return [];
    const read = (index: number) => index < 0 ? "" : (row[index] || "").trim();
    const contact = read(columns.contact);
    const parsedContact = parseContactCell(contact);
    const combine = (existing: string, parsed: string[]) => [existing, ...parsed].filter(Boolean).join("\n");
    return [{
      channelName: read(columns.channelName),
      youtubeChannelId: read(columns.youtubeChannelId),
      category: read(columns.category),
      state: read(columns.state),
      region: read(columns.region),
      district: read(columns.district),
      emails: combine(read(columns.emails), parsedContact.emails),
      phones: combine(read(columns.phones), parsedContact.phones),
      contact,
      socialLinks: combine(read(columns.socialLinks), parsedContact.socialLinks),
      websites: combine(read(columns.websites), parsedContact.websites),
    }];
  });
}

function parseCsv(source: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[index + 1] === "\n") index += 1;
      row.push(field);
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      field = "";
    } else field += char;
  }
  row.push(field);
  if (row.some((value) => value.trim())) rows.push(row);
  if (rows[0]?.[0]) rows[0][0] = rows[0][0].replace(/^\uFEFF/, "");
  return rows;
}

async function parseXlsx(file: File): Promise<string[][]> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const entries = findZipEntries(bytes);
  const workbookXml = await readZipEntry(bytes, entries.get("xl/workbook.xml"));
  const relationshipsXml = await readZipEntry(bytes, entries.get("xl/_rels/workbook.xml.rels"));
  if (!workbookXml || !relationshipsXml) throw new Error("The Excel workbook is missing its worksheet list.");

  const workbook = xmlDocument(workbookXml);
  const relationships = xmlDocument(relationshipsXml);
  const firstSheet = Array.from(workbook.getElementsByTagName("sheet"))
    .find((sheet) => sheet.getAttribute("state") !== "hidden");
  if (!firstSheet) throw new Error("The Excel workbook has no visible worksheet.");
  const relationId = firstSheet.getAttribute("r:id") || firstSheet.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id");
  const relationship = Array.from(relationships.getElementsByTagName("Relationship"))
    .find((item) => item.getAttribute("Id") === relationId);
  const target = relationship?.getAttribute("Target");
  if (!target) throw new Error("The first worksheet could not be found in the Excel workbook.");
  const sheetPath = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
  const sheetXml = await readZipEntry(bytes, entries.get(sheetPath));
  if (!sheetXml) throw new Error("The first worksheet could not be opened.");

  const stringsXml = await readZipEntry(bytes, entries.get("xl/sharedStrings.xml"));
  const sharedStrings = stringsXml
    ? Array.from(xmlDocument(stringsXml).getElementsByTagName("si")).map((item) =>
      Array.from(item.getElementsByTagName("t")).map((text) => text.textContent || "").join(""))
    : [];
  const sheet = xmlDocument(sheetXml);
  const result: string[][] = [];
  const sheetRows = Array.from(sheet.getElementsByTagName("row"));
  if (sheetRows.length > 2001) throw new Error("Import up to 2,000 rows at a time.");
  let totalCells = 0;
  for (const rowElement of sheetRows) {
    const row: string[] = [];
    for (const cell of Array.from(rowElement.getElementsByTagName("c"))) {
      const index = columnIndex(cell.getAttribute("r") || "A");
      if (index >= 100 || ++totalCells > 50_000) throw new Error("This worksheet has too many columns or cells to import safely.");
      const type = cell.getAttribute("t");
      const value = cell.getElementsByTagName("v")[0]?.textContent || "";
      const inlineValue = Array.from(cell.getElementsByTagName("t")).map((text) => text.textContent || "").join("");
      row[index] = type === "s" ? (sharedStrings[Number(value)] || "") : type === "inlineStr" ? inlineValue : value;
    }
    result.push(Array.from({ length: row.length }, (_, index) => row[index] || ""));
  }
  return result;
}

export async function readChannelSpreadsheet(file: File): Promise<ChannelImportRow[]> {
  if (!file.name || file.name.length > 255) throw new Error("Choose a file with a valid name.");
  if (file.size > 20 * 1024 * 1024) throw new Error("Choose a spreadsheet smaller than 20 MB.");
  const extension = file.name.toLocaleLowerCase().split(".").pop();
  const grid = extension === "csv"
    ? parseCsv(await file.text())
    : extension === "xlsx"
      ? await parseXlsx(file)
      : null;
  if (!grid) throw new Error("Choose an .xlsx Excel workbook or a .csv file.");
  const rows = rowsToChannels(grid);
  if (!rows.length) throw new Error("The first worksheet has the column headings but no data rows.");
  if (rows.length > 2000) throw new Error("Import up to 2,000 rows at a time.");
  return rows;
}
