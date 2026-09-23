import nodemailer from 'nodemailer';
let transport;
export async function sendVerificationCode(email,code){
 if(!process.env.SMTP_HOST){console.log(`[DEV EMAIL] ${email}: ${code}`);return 'development';}
 transport??=nodemailer.createTransport({host:process.env.SMTP_HOST,port:Number(process.env.SMTP_PORT??587),secure:process.env.SMTP_SECURE==='true',auth:{user:process.env.SMTP_USER,pass:process.env.SMTP_PASSWORD}});
 await transport.sendMail({from:process.env.MAIL_FROM,to:email,subject:'Код подтверждения Marketplace Control',text:`Код подтверждения: ${code}. Он действует 10 минут.`,html:`<p>Код подтверждения:</p><h1 style="letter-spacing:6px">${code}</h1><p>Он действует 10 минут.</p>`});return 'smtp';
}
