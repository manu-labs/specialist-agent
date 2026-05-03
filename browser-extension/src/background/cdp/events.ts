// Subset of Chrome DevTools Protocol "Network" event payloads we use.
// Field types lifted from the DevTools Protocol viewer; only the ones we
// actually read are typed.

export interface CdpRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  postData?: string;
  hasPostData?: boolean;
}

export interface CdpResponse {
  url: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  mimeType: string;
  encodedDataLength?: number;
}

export interface RequestWillBeSent {
  requestId: string;
  loaderId: string;
  documentURL: string;
  request: CdpRequest;
  timestamp: number;
  wallTime: number;
  initiator?: { type: string };
  redirectResponse?: CdpResponse;
  type?: string;
  frameId?: string;
}

export interface RequestWillBeSentExtraInfo {
  requestId: string;
  headers: Record<string, string>;
  associatedCookies?: unknown[];
}

export interface ResponseReceived {
  requestId: string;
  loaderId: string;
  timestamp: number;
  type: string;
  response: CdpResponse;
  frameId?: string;
}

export interface ResponseReceivedExtraInfo {
  requestId: string;
  headers: Record<string, string>;
  statusCode?: number;
}

export interface DataReceived {
  requestId: string;
  timestamp: number;
  dataLength: number;
  encodedDataLength: number;
}

export interface LoadingFinished {
  requestId: string;
  timestamp: number;
  encodedDataLength: number;
}

export interface LoadingFailed {
  requestId: string;
  timestamp: number;
  type: string;
  errorText: string;
  canceled?: boolean;
}

export interface GetResponseBodyResult {
  body: string;
  base64Encoded: boolean;
}
