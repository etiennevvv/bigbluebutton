import Interop from '@jitsi/sdp-interop';
import transform from 'sdp-transform';
import logger from '/imports/startup/client/logger';

// sdp-interop library for unified-plan <-> plan-b translation
const interop = new Interop.Interop();

// Some heuristics to determine if the input SDP is Unified Plan
const isUnifiedPlan = (sdp) => {
  const parsedSDP = transform.parse(sdp);
  if (parsedSDP.media.length <= 3 && parsedSDP.media.every(m => ['video', 'audio', 'data'].indexOf(m.mid) !== -1)) {
    logger.info({ logCode: 'sdp_utils_not_unified_plan' }, 'SDP does not look like Unified Plan');
    return false;
  }

  logger.info({ logCode: 'sdp_utils_is_unified_plan' }, 'SDP looks like Unified Plan');

  return true;
};

// Some heuristics to determine if the input SDP is Plan B
const isPlanB = (sdp) => {
  const parsedSDP = transform.parse(sdp);
  if (parsedSDP.media.length > 3 || !parsedSDP.media.every(m => ['video', 'audio', 'data'].indexOf(m.mid) !== -1)) {
    logger.info({ logCode: 'sdp_utils_not_plan_b' }, 'SDP does not look like Plan B');
    return false;
  }

  logger.info({ logCode: 'sdp_utils_is_plan_b' }, 'SDP looks like Plan B');

  return true;
};


// Specific method for translating FS SDPs from Plan B to Unified Plan (vice-versa)
const toPlanB = (unifiedPlanSDP) => {
  const planBSDP = interop.toPlanB(unifiedPlanSDP);
  logger.info({ logCode: 'sdp_utils_unified_plan_to_plan_b' }, `Converted Unified Plan to Plan B ${JSON.stringify(planBSDP)}`);
  return planBSDP;
};

const toUnifiedPlan = (planBSDP) => {
  const unifiedPlanSDP = interop.toUnifiedPlan(planBSDP);
  logger.info({ logCode: 'sdp_utils_plan_b_to_unified_plan' }, `Converted Plan B to Unified Plan ${JSON.stringify(unifiedPlanSDP)}`);
  return unifiedPlanSDP;
};

const stripMDnsCandidates = (sdp) => {
  const parsedSDP = transform.parse(sdp);
  let strippedCandidates = 0;
  parsedSDP.media.forEach((media) => {
    if (media.candidates) {
      media.candidates = media.candidates.filter((candidate) => {
        if (candidate.ip && candidate.ip.indexOf('.local') === -1) {
          return true;
        }
        strippedCandidates += 1;
        return false;
      });
    }
  });
  if (strippedCandidates > 0) {
    logger.info({ logCode: 'sdp_utils_mdns_candidate_strip' }, `Stripped ${strippedCandidates} mDNS candidates`);
  }
  return transform.write(parsedSDP);
};

const analyzeSdp = (sdp) => {
  // For now we just need to parse and log the different pieces. In the future we're going to want
  // to be tracking whether there were TURN candidates and IPv4 candidates to make informed
  // decisions about what to do on fallbacks/reconnects.
  const parsedSDP = transform.parse(sdp);

  const v4Info = {
    found: false,
    public: false,
  };

  const v6Info = {
    found: false,
    public: false,
  };

  const srflxInfo = {
    found: false,
    type: 'not found',
    public: false,
  };

  const prflxInfo = {
    found: false,
    type: 'not found',
    public: false,
  };

  const relayInfo = {
    found: false,
    type: 'not found',
    public: false,
  };

  const isPublicIpv4 = (ip) => {
    const ipParts = ip.split('.');
    switch (ipParts[0]) {
      case 10:
      case 127:
        return false;
      case 172:
        return ipParts[1] <= 16 || ipParts[1] > 32;
      case 192:
        return ipParts[1] !== 168;
      default:
        return true;
    }
  };

  const parseIP = (ip) => {
    if (ip.indexOf(':') !== -1) return { type: 'v6', public: true };
    if (ip.indexOf('.local') !== -1) return { type: 'mdns', public: false };
    if (ip.indexOf('.')) return { type: 'v4', public: isPublicIpv4(ip) };
    return { type: 'unknown', public: false };
  };

  // Things to parse:
  // Are there any IPv4/IPv6
  // Is there a server reflexive candidate? (srflx) is a public or private IP
  // Is there a relay (TURN) candidate
  parsedSDP.media.forEach((media) => {
    if (media.candidates) {
      // console.log("**** Found candidates ****")
      media.candidates.forEach((candidate) => {
        // console.log(candidate)
        const ipInfo = parseIP(candidate.ip);
        switch (ipInfo.type) {
          case 'v4':
            v4Info.found = true;
            v4Info.public = v4Info.public || ipInfo.public;
            break;
          case 'v6':
            v6Info.found = true;
            v6Info.public = v6Info.public || ipInfo.public;
            break;
        }

        switch (candidate.type) {
          case 'srflx':
            srflxInfo.found = true;

            if (srflxInfo.type === 'not found') {
              srflxInfo.type = ipInfo.type;
            } else if (srflxInfo.type !== ipInfo.type) {
              srflxInfo.type = 'both';
            }

            srflxInfo.public = srflxInfo.public || ipInfo.public;
            break;
          case 'prflx':
            prflxInfo.found = true;

            if (prflxInfo.type === 'not found') {
              prflxInfo.type = ipInfo.type;
            } else if (prflxInfo.type !== ipInfo.type) {
              prflxInfo.type = 'both';
            }

            prflxInfo.public = prflxInfo.public || ipInfo.public;
            break;
          case 'relay':
            relayInfo.found = true;

            if (relayInfo.type === 'not found') {
              relayInfo.type = ipInfo.type;
            } else if (relayInfo.type !== ipInfo.type) {
              relayInfo.type = 'both';
            }

            relayInfo.public = relayInfo.public || ipInfo.public;
            break;
        }
      });
      // console.log("**** End of candidates ****")
    }
  });

  // candidate types
  logger.info({
    logCode: 'sdp_utils_candidate_types',
    extraInfo: {
      foundV4Candidate: v4Info.found,
      foundV4PublicCandidate: v4Info.public,
      foundV6Candidate: v6Info.found,
    },
  }, `Found candidates ${v4Info.found ? 'with' : 'without'} type v4 (public? ${v4Info.public}) and ${v6Info.found ? 'with' : 'without'} type v6`);

  // server reflexive
  if (srflxInfo.found) {
    logger.info({
      logCode: 'sdp_utils_server_reflexive_found',
      extraInfo: {
        candidateType: srflxInfo.type,
        candidatePublic: srflxInfo.public,
      },
    }, 'Found a server reflexive candidate');
  } else {
    logger.info({
      logCode: 'sdp_utils_no_server_reflexive',
    }, 'No server reflexive candidate found');
  }

  // peer reflexive
  if (prflxInfo.found) {
    logger.info({
      logCode: 'sdp_utils_peer_reflexive_found',
      extraInfo: {
        candidateType: prflxInfo.type,
        candidatePublic: prflxInfo.public,
      },
    }, 'Found a peer reflexive candidate');
  } else {
    logger.info({
      logCode: 'sdp_utils_no_peer_reflexive',
    }, 'No peer reflexive candidate found');
  }

  // relay
  if (relayInfo.found) {
    logger.info({
      logCode: 'sdp_utils_relay_found',
      extraInfo: {
        candidateType: relayInfo.type,
        candidatePublic: relayInfo.public,
      },
    }, 'Found a relay candidate');
  } else {
    logger.info({
      logCode: 'sdp_utils_no_relay',
    }, 'No relay candidate found');
  }
};

export {
  interop,
  isUnifiedPlan,
  toPlanB,
  toUnifiedPlan,
  stripMDnsCandidates,
  analyzeSdp,
};
