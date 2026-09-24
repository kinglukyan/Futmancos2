import { generateKeyPairSync } from 'node:crypto';

const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const publicJwk = publicKey.export({ format: 'jwk' });
const privateJwk = privateKey.export({ format: 'jwk' });
const publicBytes = Buffer.concat([Buffer.from([4]), Buffer.from(publicJwk.x, 'base64url'), Buffer.from(publicJwk.y, 'base64url')]);
const privateBytes = Buffer.from(privateJwk.d, 'base64url');
console.log('Copie estes valores para Environment no Render:');
console.log(`VAPID_PUBLIC_KEY=${publicBytes.toString('base64url')}`);
console.log(`VAPID_PRIVATE_KEY=${privateBytes.toString('base64url')}`);
console.log('VAPID_SUBJECT=mailto:santoslucasalmeida@gmail.com');
console.log('\nGuarde a chave privada em sigilo e não gere outro par depois de configurar.');
