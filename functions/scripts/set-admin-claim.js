// Bootstrap / utility — setea (o revoca) el custom claim `admin: true`
// en un usuario de Firebase Auth. Una vez seteado, el target debe cerrar
// sesión y volver a entrar (o llamar `getIdToken(true)`) para que el
// claim aparezca en su ID token.
//
// Auth: usa Application Default Credentials. Antes de correrlo:
//   1. gcloud auth application-default login
//   2. gcloud config set project styleapp-1e840   (opcional si pasás --project)
//
// Uso:
//   node scripts/set-admin-claim.js <email>                # promueve a admin
//   node scripts/set-admin-claim.js --uid <uid>            # por uid
//   node scripts/set-admin-claim.js <email> --revoke       # revoca
//   node scripts/set-admin-claim.js <email> --project <id> # override projectId

const admin = require('firebase-admin');

const PROJECT_ID_DEFAULT = 'styleapp-1e840';

function parseArgs(argv) {
  const args = { revoke: false, projectId: PROJECT_ID_DEFAULT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--revoke') args.revoke = true;
    else if (a === '--uid') args.uid = argv[++i];
    else if (a === '--project') args.projectId = argv[++i];
    else if (!a.startsWith('--') && !args.email && !args.uid) args.email = a;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.email && !args.uid) {
    console.error('Falta email o --uid.\nUso: node scripts/set-admin-claim.js <email> [--revoke]');
    process.exit(1);
  }

  admin.initializeApp({ projectId: args.projectId });

  let user;
  try {
    user = args.uid
      ? await admin.auth().getUser(args.uid)
      : await admin.auth().getUserByEmail(args.email.trim().toLowerCase());
  } catch (err) {
    console.error(`No se pudo encontrar el usuario: ${err.code || err.message}`);
    process.exit(1);
  }

  const grant = !args.revoke;
  const existing = user.customClaims || {};
  const next = { ...existing, admin: grant };

  await admin.auth().setCustomUserClaims(user.uid, next);

  console.log(`OK — claim aplicado en proyecto ${args.projectId}`);
  console.log(`  uid:    ${user.uid}`);
  console.log(`  email:  ${user.email || '(sin email)'}`);
  console.log(`  admin:  ${grant}`);
  console.log(`  claims: ${JSON.stringify(next)}`);
  console.log('\nEl usuario debe cerrar sesión y volver a entrar (o llamar getIdToken(true))');
  console.log('para que el claim aparezca en su ID token.');
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
