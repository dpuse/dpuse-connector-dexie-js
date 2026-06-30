import { Dexie } from 'dexie';
import { PreviewConfig } from '@dpuse/dpuse-shared/component/dataView';
import { ToolConfig } from '@dpuse/dpuse-shared/component/module/tool';
import { ConnectorConfig, ConnectorInterface, ConnectorUtilities, CreateObjectOptions, DropObjectOptions, FindObjectOptions, FindObjectResult, GetRecordOptions, GetRecordResult, ListNodesOptions, ListNodesResult, PreviewObjectOptions, RecordRetrievalTypeId, RemoveRecordsOptions, RetrieveRecordsOptions, RetrieveRecordsSummary, UpsertRecordsOptions } from '@dpuse/dpuse-shared/component/module/connector';
interface ExtendedConnectorInterface extends ConnectorInterface {
    containers: Record<string, Dexie>;
}
export declare class Connector implements ExtendedConnectorInterface {
    abortController: AbortController | undefined;
    readonly config: ConnectorConfig;
    connectorUtilities: ConnectorUtilities;
    readonly toolConfigs: ToolConfig[];
    containers: Record<string, Dexie>;
    constructor(connectorUtilities: ConnectorUtilities, toolConfigs: ToolConfig[]);
    abortOperation(): void;
    createObject(options: CreateObjectOptions): Promise<void>;
    dropObject(options: DropObjectOptions): Promise<void>;
    findObject(options: FindObjectOptions): Promise<FindObjectResult>;
    getRecord(options: GetRecordOptions): Promise<GetRecordResult>;
    listNodes(settings: ListNodesOptions): Promise<ListNodesResult>;
    previewObject(options: PreviewObjectOptions): Promise<PreviewConfig>;
    upsertRecords(options: UpsertRecordsOptions): Promise<void>;
    removeRecords(options: RemoveRecordsOptions): Promise<void>;
    retrieveRecords(options: RetrieveRecordsOptions, chunk: (typeId: RecordRetrievalTypeId, records: Record<string, unknown>[]) => void, complete: (result: RetrieveRecordsSummary) => void): Promise<void>;
    private establishContainer;
    private establishObjectIdentifiers;
}
export {};
