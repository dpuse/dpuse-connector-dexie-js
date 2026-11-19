// ── External Dependencies & Registrations
import 'fake-indexeddb/auto'; // An in-memory IndexedDB for Node, loaded before Dexie so Dexie finds it.
import { Dexie } from 'dexie';
import { afterEach, describe, expect, it } from 'vitest';

// ── DPUse Framework
import type { StoreRecord } from '@dpuse/dpuse-shared';

// ── Local Framework
import { constructRecordPacker, countPackedRecords, isPackedTable, PACK_RECORD_COUNT, PACKED_TABLE_SCHEMA, readAllPackedRecords } from '@/packedRecords';
import { type PackedTable, readPackedRecordChunks, readPackedRecords } from '@/packedRecords';

// ── Constants ────────────────────────────────────────────────────────────────────────────────────────────────────────

const DATABASE_NAME = 'packed';

// ── State ────────────────────────────────────────────────────────────────────────────────────────────────────────────

const databases: Dexie[] = []; // Each test's databases, closed afterwards so they can be deleted.

// ── Tests ────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('packed records', () => {
    afterEach(async () => {
        for (const database of databases.splice(0)) database.close();
        await Dexie.delete(DATABASE_NAME);
    });

    describe('constructRecordPacker', () => {
        it('stores records a full pack at a time, however they arrive, and the rest at the finish', async () => {
            const table = await openPackedTable();
            const recordPacker = constructRecordPacker(table);

            await recordPacker.addRecords(numberRecords(0, 700));
            expect(await table.count()).toBe(0); // Not yet a full pack.
            await recordPacker.addRecords(numberRecords(700, 1500));
            await recordPacker.addRecords(numberRecords(2200, 300));
            expect(await table.orderBy(':id').primaryKeys()).toEqual([0, PACK_RECORD_COUNT]);
            await recordPacker.finish();

            const recordPacks = await table.toArray();
            expect(recordPacks.map(({ firstRecordIndex, records }) => [firstRecordIndex, records.length])).toEqual([
                [0, 1000],
                [1000, 1000],
                [2000, 500]
            ]);
            expect(await readAllPackedRecords(table)).toEqual(numberRecords(0, 2500));
        });

        it('stores nothing for a load with no records', async () => {
            const table = await openPackedTable();
            const recordPacker = constructRecordPacker(table);

            await recordPacker.addRecords([]);
            await recordPacker.finish();

            expect(await table.count()).toBe(0);
            expect(await countPackedRecords(table)).toBe(0);
        });
    });

    describe('countPackedRecords', () => {
        it.each([1, 999, 1000, 1001, 2500])('counts %i records', async (recordCount) => {
            const table = await fillPackedTable(recordCount);

            expect(await countPackedRecords(table)).toBe(recordCount);
        });
    });

    describe('isPackedTable', () => {
        it('knows a packed table by its key, and any other table as not packed', async () => {
            const database = new Dexie(DATABASE_NAME);
            databases.push(database);
            database.version(1).stores({ keyed: 'code', numbered: '++', packed: PACKED_TABLE_SCHEMA });
            await database.open();

            expect(isPackedTable(database.table('packed'))).toBe(true);
            expect(isPackedTable(database.table('numbered'))).toBe(false);
            expect(isPackedTable(database.table('keyed'))).toBe(false);
        });
    });

    describe('readPackedRecords', () => {
        it.each([
            ['at the start', 0, 3, [0, 1, 2]],
            ['inside a pack', 500, 2, [500, 501]],
            ['across two packs', 998, 4, [998, 999, 1000, 1001]],
            ['starting at a pack', 1000, 2, [1000, 1001]],
            ['ending with a pack', 997, 3, [997, 998, 999]],
            ['running past the end', 2498, 10, [2498, 2499]],
            ['starting past the end', 2500, 10, []],
            ['none asked for', 5, 0, []]
        ])('reads a page %s', async (_, offset, limit, values) => {
            const table = await fillPackedTable(2500);

            expect(await readPackedRecords(table, offset, limit)).toEqual(values.map((value) => [value]));
        });

        it('reads a page across more than two packs', async () => {
            const table = await fillPackedTable(3500);

            const records = await readPackedRecords(table, 900, 2200);

            expect(records).toEqual(numberRecords(900, 2200));
        });
    });

    describe('readPackedRecordChunks', () => {
        it.each([
            ['smaller than a pack', 300, 2500, [300, 300, 300, 300, 300, 300, 300, 300, 100]],
            ['one pack', 1000, 2500, [1000, 1000, 500]],
            ['several packs', 2000, 4500, [2000, 2000, 500]],
            ['not a whole number of packs', 1500, 4500, [1500, 1500, 1500]],
            ['larger than the table', 10_000, 2500, [2500]]
        ])('reads every record in order in chunks %s', async (_, chunkSize, recordCount, chunkLengths) => {
            const table = await fillPackedTable(recordCount);

            const chunks = await readChunks(table, chunkSize);

            expect(chunks.map((chunk) => chunk.length)).toEqual(chunkLengths);
            expect(chunks.flat()).toEqual(numberRecords(0, recordCount));
        });

        it('reads nothing from an empty table', async () => {
            const table = await openPackedTable();

            expect(await readChunks(table, 100)).toEqual([]);
        });
    });
});

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────────────────────────────

async function fillPackedTable(recordCount: number): Promise<PackedTable> {
    const table = await openPackedTable();
    const recordPacker = constructRecordPacker(table);
    await recordPacker.addRecords(numberRecords(0, recordCount));
    await recordPacker.finish();
    return table;
}

// Records whose one value is its position in the table, so a wrong or missing record shows.
function numberRecords(firstValue: number, recordCount: number): StoreRecord[] {
    return Array.from({ length: recordCount }, (_value, index) => [firstValue + index]);
}

async function openPackedTable(): Promise<PackedTable> {
    const database = new Dexie(DATABASE_NAME);
    databases.push(database);
    database.version(1).stores({ records: PACKED_TABLE_SCHEMA });
    await database.open();
    return database.table('records');
}

function readChunks(table: PackedTable, chunkSize: number): Promise<StoreRecord[][]> {
    return Array.fromAsync(readPackedRecordChunks(table, chunkSize));
}
