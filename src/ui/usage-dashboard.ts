import type {ObservabilityGroup} from './conversation-observability'
export interface UsageTotals {requests:number;failed:number;cancelled:number;total:ObservabilityGroup;worker:ObservabilityGroup;runtime:ObservabilityGroup}
export interface UsageDashboard extends UsageTotals {range:string;timeZone:string;startDay:string;endDay:string;asOf:string;buckets:Array<UsageTotals&{key:string;label:string}>;rounds:Array<UsageTotals&{roundId:string|null;startedAt:string;firstSequence:number;records:number}>}
