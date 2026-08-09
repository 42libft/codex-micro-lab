export const CODEX_MICRO = {
  vendorId: 0x303a,
  productId: 0x8360,
  creatorProductIds: [0x8297, 0x8298],
  usagePage: 0xff00,
  reportId: 6,
  rpcChannel: 2,
} as const;

export type DeviceModel = "codex-micro" | "creator-micro-v2";

export interface VirtualDeviceDescriptor {
  portPath: string;
  devicePid: string;
  /** Work Louder's ConnectionType.hid enum (1) covers USB and Bluetooth HID. */
  connectionType: 1;
  /** String value used by Work Louder's device-kit-oai enum. */
  deviceType: "codex_micro" | "creator_micro_v2";
  layoutType: "universal";
  isUsbConnection: boolean;
}

export interface RpcRequest {
  method: string;
  params?: unknown;
  id: string | number;
}

export interface RpcResponse {
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface HidInput {
  key: string;
  act: 0 | 1 | 2;
  agent?: number;
  eventId?: string;
}

export interface JoystickInput {
  angle: number;
  distance: number;
  eventId?: string;
}

export interface TextInput {
  text: string;
  eventId?: string;
}

export type AgentStatus = "off" | "idle" | "working" | "awaiting-approval" | "awaiting-response" | "unread" | "error";
export interface AgentSlotSnapshot {
  slot: number;
  status: AgentStatus;
  selected: boolean;
  rgb: number | null;
}

export type AgentSource = "recent" | "pinned" | "priority" | "custom" | null;
export type EncoderMode = "custom" | "reasoning" | "conversation-scroll" | "composer-navigation" | null;

export interface LayoutSnapshot {
  agentSource: AgentSource;
  actionKeys: Record<string, string | null>;
  analogStick: { up: string | null; right: string | null; down: string | null; left: string | null };
  encoderMode: EncoderMode;
  encoder: { left: string | null; click: string | null; right: string | null; longPress: string | null };
  microphoneMode: "push-to-talk" | "realtime" | null;
  separateMicrophoneKeys: boolean | null;
}

export interface ReasoningSnapshot {
  displayName: string | null;
  current: number | null;
  choices: string[] | null;
  available: boolean;
}

export interface CodexStateSnapshot {
  status: "not-detected" | "detected" | "connected" | "error";
  transport: "usb" | "bluetooth" | "unknown" | null;
  model: "codex-micro" | "creator-micro-v2" | null;
  error: string | null;
  lastResponseAt: string | null;
}

export type InputAckState = "bridge-accepted" | "codex-delivered" | "confirmed" | "unavailable" | "failed";
export interface InputAck {
  eventId: string;
  state: InputAckState;
  inputType: "hid" | "joystick" | "text";
  key?: string;
  reason?: string;
}

export interface DeviceTelemetry {
  batteryPercentage?: number;
  isCharging?: boolean;
  firmwareVersion?: string;
}

export interface LightingState {
  keys: Record<string, unknown>;
  ambient: Record<string, unknown>;
  threads: unknown[];
}

export type BridgeClientRole = "codex-shim" | "codex-probe" | "codex-renderer" | "iphone" | "web";

export type BridgeMessage =
  | { version: 1; type: "hello"; role: BridgeClientRole; token?: string }
  | { version: 1; type: "device.list"; requestId: string }
  | { version: 1; type: "topology.subscribe" }
  | { version: 1; type: "rpc.request"; requestId: string; raw: string }
  | { version: 1; type: "input.hid"; input: HidInput }
  | { version: 1; type: "input.joystick"; input: JoystickInput }
  | { version: 1; type: "input.text"; input: TextInput }
  | { version: 1; type: "device.telemetry"; telemetry: DeviceTelemetry }
  | { version: 1; type: "heartbeat"; nonce?: string }
  | { version: 1; type: "pairing.reset" }
  | { version: 1; type: "codex.semantic"; event: "agent.snapshot" | "layout.snapshot" | "reasoning.snapshot" | "codex.state" | "input.ack"; payload: AgentSlotSnapshot | LayoutSnapshot | ReasoningSnapshot | CodexStateSnapshot | InputAck };

export type BridgeReply =
  | { version: 1; type: "hello.ok"; sessionId: string; role: BridgeClientRole }
  | { version: 1; type: "device.list.result"; requestId: string; devices: VirtualDeviceDescriptor[] }
  | { version: 1; type: "rpc.response"; requestId: string; raw: string }
  | { version: 1; type: "rpc.notification"; raw: string }
  | { version: 1; type: "input.text"; input: TextInput }
  | { version: 1; type: "topology.changed"; available: boolean }
  | { version: 1; type: "lighting.snapshot"; lighting: LightingState }
  | { version: 1; type: "connection.state"; state: "available" | "unavailable"; reason?: string }
  | { version: 1; type: "agent.snapshot"; snapshot: AgentSlotSnapshot }
  | { version: 1; type: "codex.state"; snapshot: CodexStateSnapshot }
  | { version: 1; type: "input.ack"; ack: InputAck }
  | { version: 1; type: "heartbeat.ok"; nonce?: string }
  | { version: 1; type: "error"; message: string };
