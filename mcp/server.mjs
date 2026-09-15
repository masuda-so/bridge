import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createServer } from './tools.mjs';
import { Channel, listenChannel } from './channel.mjs';
import { loadChannelConfig } from './channel-config.mjs';
// Disabled by default. Configuring the MCP receiver does not enable the host's
// Channels allowlist opt-in, and never changes Claude permission settings.
const channelConfig=await loadChannelConfig();
const channel=channelConfig?new Channel({sessionId:channelConfig.sessionId}):undefined;
const server=createServer(undefined,{channel});
await server.connect(new StdioServerTransport());
let listener;
if(channel){
  listener=await listenChannel(channel,channelConfig);
  process.stderr.write(`bridge channel listening on 127.0.0.1:${listener.port}; host opt-in and UI delivery remain unverified\n`);
}
let closing;
const close=()=>closing??=(async()=>{await listener?.close();channel?.close();await server.closeCodexReceiver();})();
server.server.onclose=close;
// An HTTP listener would otherwise keep an optional channel process alive
// after the host closes stdin. Shut it down without requiring a signal.
process.stdin.once('end',async()=>{await close();await server.close();});
