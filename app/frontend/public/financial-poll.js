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

export function startFinancialSyncPolling({
  statusUrl,
  fetchImpl,
  update,
  isHidden=()=>false,
  addVisibilityListener=()=>{},
  setTimer=setTimeout,
  clearTimer=clearTimeout,
  intervalMs=5000,
  errorIntervalMs=30000,
  maxConsecutiveErrors=3,
  requestTimeoutMs=12000,
  AbortControllerImpl=AbortController,
  onError=()=>{}
}){
  let timer=null,requestTimer=null,inFlight=false,stopped=false,consecutiveErrors=0,nextDelay=intervalMs;
  const clear=()=>{if(timer!==null){clearTimer(timer);timer=null}};
  const schedule=()=>{clear();if(!stopped&&!isHidden())timer=setTimer(()=>{timer=null;void checkNow()},nextDelay)};
  const checkNow=async()=>{
    clear();
    if(stopped||inFlight)return;
    if(isHidden()){schedule();return}
    inFlight=true;
    const controller=new AbortControllerImpl();
    requestTimer=setTimer(()=>controller.abort(),requestTimeoutMs);
    try{
      const response=await fetchImpl(statusUrl,{headers:{accept:'application/json'},cache:'no-store',signal:controller.signal,credentials:'same-origin'});
      if(response.ok){consecutiveErrors=0;nextDelay=intervalMs;const state=await response.json();update(state);if(!state.running)stopped=true}
      else if(response.status===401||response.status===403){onError({reason:'auth',terminal:true});stopped=true}
      else{consecutiveErrors++;if(consecutiveErrors>=maxConsecutiveErrors){nextDelay=errorIntervalMs;onError({reason:'unavailable',terminal:false})}}
    }catch{consecutiveErrors++;if(consecutiveErrors>=maxConsecutiveErrors){nextDelay=errorIntervalMs;onError({reason:'unavailable',terminal:false})}}
    finally{
      if(requestTimer!==null){clearTimer(requestTimer);requestTimer=null}
      inFlight=false;
      if(!stopped)schedule();
    }
  };
  addVisibilityListener(()=>{if(!isHidden())schedule()});
  schedule();
  return{checkNow,stop(){stopped=true;clear();if(requestTimer!==null){clearTimer(requestTimer);requestTimer=null}}};
}
