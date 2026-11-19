// ── External Dependencies & Registrations
import type { Table } from 'dexie';

// ── DPUse Framework
import type { StoreRecord } from '@dpuse/dpuse-shared';

// ── Types ────────────────────────────────────────────────────────────────────────────────────────────────────────────

// A table a store load wrote, which holds its records in packs.
export type PackedTable = Table<RecordPack, number>;

// One entry of a packed table: a run of records, each a plain list of values, keyed by the position of its first record
// in the table.
export interface RecordPack {
    firstRecordIndex: number;
    records: StoreRecord[];
}

// Takes a load's records as they arrive and stores them in packs.
export interface RecordPacker {
    addRecords: (records: StoreRecord[]) => Promise<void>;
    finish: () => Promise<void>; // Stores the records left over, which do not fill a pack.
}

// ── Constants ────────────────────────────────────────────────────────────────────────────────────────────────────────

// IndexedDB's cost is mostly per entry, and an entry for each record also repeats every field's name. So a load stores
// many records in each entry. Measured in Chromium in November 2026, on a 190 MB file of 397,000 records and 70 columns:
// an entry for each record loaded in 6.2 seconds and read back in 6.0, and 1,000 records an entry loaded in 0.3 seconds
// and read back in 0.2. Packs of 250 and of 10,000 were no faster.
export const PACK_RECORD_COUNT = 1000;

// Dexie's schema for a packed table. The key's name is what marks the table as packed.
export const PACKED_TABLE_SCHEMA = 'firstRecordIndex';

// ── Actions ──────────────────────────────────────────────────────────────────────────────────────────────────────────

// Every pack but a load's last is full, so a record's position says which pack holds it.
export function constructRecordPacker(table: PackedTable): RecordPacker {
    let pendingRecords: StoreRecord[] = [];
    let storedRecordCount = 0;
    const storeRecords = async (records: StoreRecord[]): Promise<void> => {
        const recordPacks: RecordPack[] = [];
        for (let start = 0; start < records.length; start += PACK_RECORD_COUNT) {
            recordPacks.push({ firstRecordIndex: storedRecordCount + start, records: records.slice(start, start + PACK_RECORD_COUNT) });
        }
        if (recordPacks.length > 0) await table.bulkAdd(recordPacks);
        storedRecordCount += records.length;
    };
    return {
        addRecords: async (records) => {
            pendingRecords = pendingRecords.length === 0 ? records : [...pendingRecords, ...records];
            const fullPackRecordCount = pendingRecords.length - (pendingRecords.length % PACK_RECORD_COUNT);
            const fullPackRecords = pendingRecords.slice(0, fullPackRecordCount);
            pendingRecords = pendingRecords.slice(fullPackRecordCount);
            await storeRecords(fullPackRecords);
        },
        finish: async () => {
            const lastRecords = pendingRecords;
            pendingRecords = [];
            await storeRecords(lastRecords);
        }
    };
}

// The last pack says how many records there are, so no other pack is read.
export async function countPackedRecords(table: PackedTable): Promise<number> {
    const lastRecordPack = await table.orderBy(':id').last();
    return lastRecordPack == null ? 0 : lastRecordPack.firstRecordIndex + lastRecordPack.records.length;
}

export function isPackedTable(table: Table): table is PackedTable {
    return table.schema.primKey.keyPath === PACKED_TABLE_SCHEMA;
}

export async function readAllPackedRecords(table: PackedTable): Promise<StoreRecord[]> {
    const recordPacks = await table.toArray();
    return recordPacks.flatMap((recordPack) => recordPack.records);
}

// Every record, a chunk at a time in the order they were stored. Each read starts after the last pack of the one before,
// so a chunk far into the table is found as quickly as the first.
export async function* readPackedRecordChunks(table: PackedTable, chunkSize: number): AsyncGenerator<StoreRecord[]> {
    const chunkRecordCount = Math.max(1, Math.floor(chunkSize));
    const readPackCount = Math.max(1, Math.floor(chunkRecordCount / PACK_RECORD_COUNT)); // As many packs as fill a chunk.
    let pendingRecords: StoreRecord[] = [];
    let lastFirstRecordIndex: number | undefined;
    for (;;) {
        const collection = lastFirstRecordIndex === undefined ? table.orderBy(':id') : table.where(':id').above(lastFirstRecordIndex);
        const recordPacks = await collection.limit(readPackCount).toArray();
        const lastRecordPack = recordPacks.at(-1);
        if (lastRecordPack == null) break;
        lastFirstRecordIndex = lastRecordPack.firstRecordIndex;
        for (const recordPack of recordPacks) pendingRecords.push(...recordPack.records);
        let start = 0;
        for (; pendingRecords.length - start >= chunkRecordCount; start += chunkRecordCount) yield pendingRecords.slice(start, start + chunkRecordCount);
        pendingRecords = pendingRecords.slice(start);
    }
    if (pendingRecords.length > 0) yield pendingRecords;
}

// The records from position 'offset' on, 'limit' of them at most. A pack holds no more than 'PACK_RECORD_COUNT' records,
// so the pack holding the first record wanted starts fewer than that many before it.
export async function readPackedRecords(table: PackedTable, offset: number, limit: number): Promise<StoreRecord[]> {
    const endOffset = offset + limit;
    const recordPacks = await table
        .where(':id')
        .between(offset - PACK_RECORD_COUNT + 1, endOffset, true, false)
        .toArray();
    return recordPacks.flatMap(({ firstRecordIndex, records }) => records.slice(Math.max(0, offset - firstRecordIndex), endOffset - firstRecordIndex));
}
