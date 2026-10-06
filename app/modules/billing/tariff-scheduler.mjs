const dayMs=86400000,moscowOffset=3*3600000;
export function nextTariffCheck(at=new Date()){
  if(!(at instanceof Date)||Number.isNaN(at.getTime()))throw new TypeError('valid timestamp required');
  const local=new Date(at.getTime()+moscowOffset);
  let next=Date.UTC(local.getUTCFullYear(),local.getUTCMonth(),local.getUTCDate(),0,10)-moscowOffset;
  if(next<=at.getTime())next+=dayMs;
  return new Date(next);
}

export function startTariffScheduler({expireDue,now=()=>new Date(),setTimer=setTimeout,clearTimer=clearTimeout,onError=console.error}){
  if(typeof expireDue!=='function')throw new TypeError('expireDue required');
  let stopped=false,timer;
  const tick=async()=>{
    try{await expireDue();}catch(error){onError(error);}
    if(!stopped){const at=now();timer=setTimer(()=>void tick(),nextTariffCheck(at).getTime()-at.getTime());timer.unref?.();}
  };
  void tick();
  return ()=>{stopped=true;if(timer)clearTimer(timer);};
}
