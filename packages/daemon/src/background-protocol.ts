export const BROKER_PROTOCOL = 1;
export const BROKER_DESCRIPTOR = "terminal-broker.json";
export const BROKER_SNAPSHOT = "background-snapshot.json";
export interface BrokerDescriptor {
  protocol: number;
  generation: string;
  url: string;
  token: string;
  pid: number;
  workspace: string;
}
