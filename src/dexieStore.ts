// ── DPUse Framework
import { convertStoreValueToText } from '@dpuse/dpuse-shared';
import type { QueryAggregate, QueryFilter, QueryRecordsOptions, QueryRecordsResult, QuerySort, StoreRecord, StoreValue } from '@dpuse/dpuse-shared';

// ── Actions ──────────────────────────────────────────────────────────────────────────────────────────────────────────

// Filters, groups, sorts and pages an object's records in memory, because IndexedDB cannot query them. Each step
// behaves as the SQLite and DuckDB stores' SQL does, so a data view gives the same answers in every store.
export function queryStoreRecords(records: StoreRecord[], columnCount: number, options: QueryRecordsOptions): QueryRecordsResult {
    for (const filter of options.filters) checkColumnIndex(filter.columnIndex, columnCount);
    const offset = checkCount(options.offset);
    const limit = checkCount(options.limit);
    const filteredRecords = records.filter((record) => options.filters.every((filter) => doesValueMatch(record[filter.columnIndex] ?? null, filter)));
    const isGrouped = options.groupColumnIndexes.length > 0;
    const resultRecords = isGrouped ? groupRecords(filteredRecords, columnCount, options) : filteredRecords;
    const resultColumnCount = isGrouped ? options.groupColumnIndexes.length + options.aggregates.length : columnCount;
    const sortedRecords = options.sorts.length === 0 ? resultRecords : sortRecords(resultRecords, options.sorts, resultColumnCount);
    return { records: sortedRecords.slice(offset, offset + limit), totalCount: sortedRecords.length };
}

// A page's offset and limit come from the caller, so each is checked before it is used.
export function checkCount(count: number): number {
    if (!Number.isSafeInteger(count) || count < 0) throw new Error(`${String(count)} is not a valid count.`);
    return count;
}

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────────────────────────────

// A grouped result holds the group's values, then one value per aggregate, as the SQL stores' results do.
function groupRecords(records: StoreRecord[], columnCount: number, options: QueryRecordsOptions): StoreRecord[] {
    for (const columnIndex of options.groupColumnIndexes) checkColumnIndex(columnIndex, columnCount);
    for (const aggregate of options.aggregates) if (aggregate.columnIndex != null) checkColumnIndex(aggregate.columnIndex, columnCount);
    const groups = new Map<string, StoreRecord[]>();
    for (const record of records) {
        const groupKey = JSON.stringify(options.groupColumnIndexes.map((columnIndex) => constructValueKey(record[columnIndex] ?? null)));
        const group = groups.get(groupKey);
        if (group == null) groups.set(groupKey, [record]);
        else group.push(record);
    }
    return Array.from(groups.values(), (group) => [
        ...options.groupColumnIndexes.map((columnIndex) => group[0]?.[columnIndex] ?? null),
        ...options.aggregates.map((aggregate) => aggregateValues(group, aggregate))
    ]);
}

// Empty values are left out of every aggregate but 'count', which counts records, as in SQL.
// eslint-disable-next-line sonarjs/function-return-type -- An aggregate is a count, a sum or one of the column's values.
function aggregateValues(group: StoreRecord[], aggregate: QueryAggregate): StoreValue {
    if (aggregate.functionId === 'count') return group.length;
    const { columnIndex } = aggregate;
    if (columnIndex == null) throw new Error(`Aggregate '${aggregate.functionId}' needs a column.`);
    const values = group.map((record) => record[columnIndex] ?? null).filter((value) => value !== null);
    if (aggregate.functionId === 'countDistinct') return new Set(values.map((value) => constructValueKey(value))).size;
    if (values.length === 0) return null;
    switch (aggregate.functionId) {
        case 'average':
            return Number(sumValues(values)) / values.length;
        case 'maximum':
            return selectExtremeValue(values, 1);
        case 'minimum':
            return selectExtremeValue(values, -1);
        case 'sum':
            return sumValues(values);
    }
}

// The largest value when 'direction' is 1, the smallest when it is -1.
function selectExtremeValue(values: NonNullable<StoreValue>[], direction: 1 | -1): NonNullable<StoreValue> | null {
    let extremeValue: NonNullable<StoreValue> | null = null;
    for (const value of values) if (extremeValue === null || compareValues(value, extremeValue) * direction > 0) extremeValue = value;
    return extremeValue;
}

// Whole numbers are added exactly, so a sum beyond ±2^53 stays a bigint, as in the SQL stores. Any decimal makes the
// sum a plain number.
// eslint-disable-next-line sonarjs/function-return-type -- A sum is a bigint only when it is too large to be an exact number.
function sumValues(values: NonNullable<StoreValue>[]): bigint | number {
    const isWhole = values.every((value) => typeof value === 'bigint' || (typeof value === 'number' && Number.isSafeInteger(value)));
    if (!isWhole) {
        let numberTotal = 0;
        for (const value of values) numberTotal += Number(value);
        return numberTotal;
    }
    let total = 0n;
    for (const value of values) total += BigInt(value as bigint | number);
    return total >= BigInt(Number.MIN_SAFE_INTEGER) && total <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(total) : total;
}

// Empty values sort last, whichever the direction, as in the SQL stores.
function sortRecords(records: StoreRecord[], sorts: QuerySort[], resultColumnCount: number): StoreRecord[] {
    for (const sort of sorts) checkColumnIndex(sort.columnIndex, resultColumnCount);
    return records.toSorted((left, right) => {
        for (const sort of sorts) {
            const leftValue = left[sort.columnIndex] ?? null;
            const rightValue = right[sort.columnIndex] ?? null;
            if (leftValue === null || rightValue === null) {
                if (leftValue === rightValue) continue;
                return leftValue === null ? 1 : -1;
            }
            const comparison = compareValues(leftValue, rightValue);
            if (comparison !== 0) return sort.directionId === 'descending' ? -comparison : comparison;
        }
        return 0;
    });
}

// 'equals' and 'notEquals' treat two empty values as equal, as SQL's 'IS' does. Any other comparison with an empty value
// fails, as in SQL. Text filters ignore case, as DuckDB's 'ILIKE' does.
function doesValueMatch(value: StoreValue, filter: QueryFilter): boolean {
    switch (filter.operatorId) {
        case 'isEmpty':
            return value === null;
        case 'isNotEmpty':
            return value !== null;
        case 'equals':
            return areValuesEqual(value, filter.value);
        case 'notEquals':
            return !areValuesEqual(value, filter.value);
        case 'contains':
            return doesTextMatch(value, filter.value, (text, search) => text.includes(search));
        case 'startsWith':
            return doesTextMatch(value, filter.value, (text, search) => text.startsWith(search));
        case 'endsWith':
            return doesTextMatch(value, filter.value, (text, search) => text.endsWith(search));
        case 'greaterThan':
            return value !== null && filter.value !== null && compareValues(value, filter.value) > 0;
        case 'greaterThanOrEquals':
            return value !== null && filter.value !== null && compareValues(value, filter.value) >= 0;
        case 'lessThan':
            return value !== null && filter.value !== null && compareValues(value, filter.value) < 0;
        case 'lessThanOrEquals':
            return value !== null && filter.value !== null && compareValues(value, filter.value) <= 0;
    }
}

function areValuesEqual(left: StoreValue, right: StoreValue): boolean {
    return left === null || right === null ? left === right : compareValues(left, right) === 0;
}

function doesTextMatch(value: StoreValue, searchValue: StoreValue, isMatch: (text: string, search: string) => boolean): boolean {
    return value !== null && isMatch((convertStoreValueToText(value) ?? '').toLowerCase(), (convertStoreValueToText(searchValue) ?? '').toLowerCase());
}

// Numbers and bigints compare by value, dates by time, and text by its characters, as SQL's default collation does.
function compareValues(left: NonNullable<StoreValue>, right: NonNullable<StoreValue>): number {
    const leftValue = left instanceof Date ? left.getTime() : left;
    const rightValue = right instanceof Date ? right.getTime() : right;
    if (typeof leftValue === typeof rightValue || (isNumeric(leftValue) && isNumeric(rightValue))) return Number(leftValue > rightValue) - Number(leftValue < rightValue);
    const leftText = convertStoreValueToText(left) ?? '';
    const rightText = convertStoreValueToText(right) ?? '';
    return Number(leftText > rightText) - Number(leftText < rightText);
}

function isNumeric(value: unknown): value is bigint | number {
    return typeof value === 'bigint' || typeof value === 'number';
}

// A key for a value that is the same for values SQL would group together, such as 1 and 1n.
function constructValueKey(value: StoreValue): string {
    if (value === null) return 'null';
    if (value instanceof Date) return `date:${String(value.getTime())}`;
    return `${isNumeric(value) ? 'number' : typeof value}:${String(value)}`;
}

// Column positions come from the caller, so each is checked before it is used.
function checkColumnIndex(columnIndex: number, columnCount: number): number {
    if (!Number.isSafeInteger(columnIndex) || columnIndex < 0 || columnIndex >= columnCount) throw new Error(`Column ${String(columnIndex)} does not exist.`);
    return columnIndex;
}
