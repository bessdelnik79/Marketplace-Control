export const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const exactDate=value=>{
  const text=String(value??'').trim();if(!/^\d{4}-\d{2}-\d{2}$/.test(text))return null;
  const parsed=new Date(`${text}T00:00:00Z`);return !Number.isNaN(parsed.getTime())&&parsed.toISOString().slice(0,10)===text?text:null;
};
export const cleanText=(value,max)=>{const text=String(value??'').trim().replace(/\s+/g,' ');return text.length<=max?text:null;};
