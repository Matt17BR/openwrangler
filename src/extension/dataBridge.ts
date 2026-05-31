import type { DataExplorerRequest, DataExplorerResponse } from "../shared/protocol";

export interface DataExplorerBridge {
  request(request: DataExplorerRequest): Promise<DataExplorerResponse>;
}
