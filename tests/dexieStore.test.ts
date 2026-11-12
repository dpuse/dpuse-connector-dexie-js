// ── External Dependencies & Registrations
import { describe, expect, it } from 'vitest';

// ── DPUse Framework
import type { QueryRecordsOptions, StoreRecord } from '@dpuse/dpuse-shared';

// ── Local Framework
import { checkCount, queryStoreRecords } from '@/dexieStore';

// ── Constants ────────────────────────────────────────────────────────────────────────────────────────────────────────

// The same records the SQLite store's tests load, so both stores are held to the same answers.
const RECORDS: StoreRecord[] = [
    ['North', 3, 1.5, true, new Date('2026-01-02')],
    ['South', 1, 2.5, false, new Date('2026-03-04')],
    ['North', 2, null, null, null],
    ['East_1', 4, 10, true, new Date('2026-05-06')]
];
const COLUMN_COUNT = 5;

// ── Tests ────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('queryStoreRecords', () => {
    it('returns every record in its order when nothing is asked for', () => {
        const result = query({});

        expect(result.records).toEqual(RECORDS);
        expect(result.totalCount).toBe(4);
    });

    it('pages through records and counts them all', () => {
        const result = query({ limit: 2, offset: 1, sorts: [{ columnIndex: 1, directionId: 'descending' }] });

        expect(result.records.map((record) => record[1])).toEqual([3, 2]);
        expect(result.totalCount).toBe(4);
    });

    it('sorts empty values last in either direction', () => {
        const ascending = query({ sorts: [{ columnIndex: 2, directionId: 'ascending' }] });
        const descending = query({ sorts: [{ columnIndex: 2, directionId: 'descending' }] });

        expect(ascending.records.map((record) => record[2])).toEqual([1.5, 2.5, 10, null]);
        expect(descending.records.map((record) => record[2])).toEqual([10, 2.5, 1.5, null]);
    });

    it('sorts by a second column when the first is equal', () => {
        const result = query({
            sorts: [
                { columnIndex: 0, directionId: 'ascending' },
                { columnIndex: 1, directionId: 'descending' }
            ]
        });

        expect(result.records.map((record) => [record[0], record[1]])).toEqual([
            ['East_1', 4],
            ['North', 3],
            ['North', 2],
            ['South', 1]
        ]);
    });

    it('filters records, matching wildcard characters as written and ignoring case', () => {
        const startsWith = query({ filters: [{ columnIndex: 0, operatorId: 'startsWith', value: 'east_' }] });
        const contains = query({ filters: [{ columnIndex: 0, operatorId: 'contains', value: 'OR' }] });
        const endsWith = query({ filters: [{ columnIndex: 0, operatorId: 'endsWith', value: 'th' }] });

        expect(startsWith.records.map((record) => record[0])).toEqual(['East_1']);
        expect(contains.totalCount).toBe(2);
        expect(endsWith.totalCount).toBe(3);
    });

    it('compares numbers, dates and booleans by value, and leaves empty values out of every comparison', () => {
        const combined = query({
            filters: [
                { columnIndex: 0, operatorId: 'equals', value: 'North' },
                { columnIndex: 4, operatorId: 'greaterThan', value: new Date('2026-01-01') }
            ]
        });

        expect(combined.records.map((record) => record[1])).toEqual([3]);
        expect(query({ filters: [{ columnIndex: 2, operatorId: 'lessThanOrEquals', value: 2.5 }] }).totalCount).toBe(2);
        expect(query({ filters: [{ columnIndex: 2, operatorId: 'greaterThanOrEquals', value: 2.5 }] }).totalCount).toBe(2);
        expect(query({ filters: [{ columnIndex: 1, operatorId: 'lessThan', value: 3n }] }).totalCount).toBe(2);
        expect(query({ filters: [{ columnIndex: 3, operatorId: 'equals', value: true }] }).totalCount).toBe(2);
    });

    it('treats two empty values as equal, as SQL does for equals and not equals', () => {
        expect(query({ filters: [{ columnIndex: 3, operatorId: 'isEmpty', value: null }] }).totalCount).toBe(1);
        expect(query({ filters: [{ columnIndex: 3, operatorId: 'isNotEmpty', value: null }] }).totalCount).toBe(3);
        expect(query({ filters: [{ columnIndex: 3, operatorId: 'equals', value: null }] }).totalCount).toBe(1);
        expect(query({ filters: [{ columnIndex: 3, operatorId: 'notEquals', value: null }] }).totalCount).toBe(3);
    });

    it('groups records, with aggregates after the group values', () => {
        const result = query({
            aggregates: [
                { columnIndex: undefined, functionId: 'count' },
                { columnIndex: 1, functionId: 'sum' },
                { columnIndex: 4, functionId: 'maximum' }
            ],
            groupColumnIndexes: [0],
            sorts: [{ columnIndex: 0, directionId: 'ascending' }]
        });

        expect(result.totalCount).toBe(3);
        expect(result.records).toEqual([
            ['East_1', 1, 4, new Date('2026-05-06')],
            ['North', 2, 5, new Date('2026-01-02')],
            ['South', 1, 1, new Date('2026-03-04')]
        ]);
    });

    it('leaves empty values out of every aggregate but the count', () => {
        const result = query({
            aggregates: [
                { columnIndex: 2, functionId: 'average' },
                { columnIndex: 2, functionId: 'minimum' },
                { columnIndex: 3, functionId: 'countDistinct' },
                { columnIndex: undefined, functionId: 'count' }
            ],
            groupColumnIndexes: [0],
            sorts: [{ columnIndex: 0, directionId: 'ascending' }]
        });

        expect(result.records[1]).toEqual(['North', 1.5, 1.5, 1, 2]);
    });

    it('gives an empty sum, average, minimum and maximum for a group with no values', () => {
        const result = query({
            aggregates: [
                { columnIndex: 2, functionId: 'sum' },
                { columnIndex: 2, functionId: 'average' },
                { columnIndex: 2, functionId: 'minimum' },
                { columnIndex: 2, functionId: 'maximum' }
            ],
            filters: [{ columnIndex: 2, operatorId: 'isEmpty', value: null }],
            groupColumnIndexes: [0]
        });

        expect(result.records).toEqual([['North', null, null, null, null]]);
    });

    it('adds whole numbers beyond ±2^53 exactly, and gives a plain number for a sum that fits one', () => {
        const largeRecords: StoreRecord[] = [[9_007_199_254_740_993n], [1], [2n]];

        expect(queryStoreRecords(largeRecords, 1, constructQuery({ aggregates: [{ columnIndex: 0, functionId: 'sum' }], groupColumnIndexes: [0], limit: 10 })).records).toEqual([
            [9_007_199_254_740_993n, 9_007_199_254_740_993n],
            [1, 1],
            [2n, 2]
        ]);
    });

    it('refuses a column that does not exist, and a count that is not a whole number', () => {
        expect(() => query({ sorts: [{ columnIndex: 9, directionId: 'ascending' }] })).toThrow('Column 9 does not exist.');
        expect(() => query({ filters: [{ columnIndex: 0.5, operatorId: 'equals', value: 1 }] })).toThrow('Column 0.5 does not exist.');
        expect(() => query({ aggregates: [{ columnIndex: undefined, functionId: 'sum' }], groupColumnIndexes: [0] })).toThrow("Aggregate 'sum' needs a column.");
        expect(() => checkCount(-1)).toThrow('-1 is not a valid count.');
    });
});

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────────────────────────────

function query(options: Partial<QueryRecordsOptions>): ReturnType<typeof queryStoreRecords> {
    return queryStoreRecords(RECORDS, COLUMN_COUNT, constructQuery(options));
}

function constructQuery(options: Partial<QueryRecordsOptions>): QueryRecordsOptions {
    return { aggregates: [], columnConfigs: [], filters: [], groupColumnIndexes: [], limit: 100, offset: 0, path: 'sales', sorts: [], ...options };
}
