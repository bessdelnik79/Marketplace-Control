export function startFinancialResultPolling({
  element,
  storage,
  statusUrl,
  publicationId=null,
  fetchImpl,
  reload,
  now=Date.now,
  setTimer=setTimeout,
  clearTimer=clearTimeout,
  isHidden=()=>false,
  addVisibilityListener=()=>{},
  startedAt=now(),
  pollIntervalMs=4000,
  requestTimeoutMs=12000,
  maxDurationMs=600000,
  AbortControllerImpl=AbortController
}){
  const deadline=startedAt+maxDurationMs;
  let pollTimer=null,requestTimer=null,inFlight=false,stopped=false;
  const clearPollTimer=()=>{if(pollTimer!==null){clearTimer(pollTimer);pollTimer=null}};
  const stopAtDeadline=()=>{stopped=true;clearPollTimer();element.querySelector('[data-financial-poll-note]')?.removeAttribute('hidden')};
  const schedule=()=>{
    clearPollTimer();
    if(stopped)return;
    if(now()>=deadline){stopAtDeadline();return}
    if(isHidden()||inFlight)return;
    pollTimer=setTimer(()=>{pollTimer=null;void checkNow()},pollIntervalMs);
  };
  const checkNow=async()=>{
    clearPollTimer();
    if(stopped||inFlight)return;
    if(now()>=deadline){stopAtDeadline();return}
    if(isHidden()){schedule();return}
    inFlight=true;
    const controller=new AbortControllerImpl(),remaining=Math.max(0,deadline-now());
    requestTimer=setTimer(()=>controller.abort(),Math.min(requestTimeoutMs,remaining));
    try{
      const response=await fetchImpl(statusUrl,{headers:{accept:'application/json'},cache:'no-store',signal:controller.signal,credentials:'same-origin'});
      if(response.ok){
        const status=await response.json();
        if(status.publicationId&&status.publicationId!==publicationId||status.status==='failed'){
          stopped=true;
          storage.remove();
          reload();
        }else if(status.status==='current'){
          stopped=true;
          storage.remove();
          clearPollTimer();
        }
      }
    }catch{}
    finally{
      if(requestTimer!==null){clearTimer(requestTimer);requestTimer=null}
      inFlight=false;
      if(!stopped)schedule();
    }
  };
  addVisibilityListener(schedule);
  schedule();
  return{checkNow,stop(){stopped=true;clearPollTimer();if(requestTimer!==null){clearTimer(requestTimer);requestTimer=null}}};
}
