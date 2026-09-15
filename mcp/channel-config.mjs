import {loadChannelPeers} from './channel-peers.mjs';

// File mode uses the same private credentials as the sender. The relay host
// needs only a peer ID, so a missing shell export cannot become a literal
// ${BRIDGE_CHANNEL_TOKEN} and prevent the MCP receiver from starting.
export async function loadChannelConfig(env=process.env){
  if(env.BRIDGE_CLAUDE_CHANNEL!=='1')return undefined;
  if(env.BRIDGE_CHANNEL_PEER_ID!==undefined){
    const peerId=env.BRIDGE_CHANNEL_PEER_ID;
    if(typeof peerId!=='string'||!peerId.trim())throw Error('Channel peer ID required');
    const peers=await loadChannelPeers(env.BRIDGE_CHANNEL_PEERS_FILE);
    const peer=peers.find(p=>p.id===peerId);
    if(!peer)throw Error('Channel peer ID is not configured in the private peers file');
    const port=Number(new URL(peer.url).port||80);
    if(port===0)throw Error('Configured channel peer must use a fixed nonzero port');
    return {sessionId:peer.sessionId,token:peer.token,port};
  }
  return {sessionId:env.BRIDGE_CHANNEL_SESSION_ID,
    token:env.BRIDGE_CHANNEL_TOKEN,port:Number(env.BRIDGE_CHANNEL_PORT??0)};
}
