const admin = require('firebase-admin');

admin.initializeApp({
  projectId: 'rertm-8a4f7'
});

const db = admin.firestore();

async function findTask() {
  const userId = 'FqwGBInqHDYqB7TlbvMnka3E6f1';
  const tasksRef = db.collection(`users/${userId}/tasks`);

  // rtmIdで検索
  const snapshot = await tasksRef.where('rtmId', '==', '302135503').get();

  if (snapshot.empty) {
    console.log('「Info」タスク（rtmId: 302135503）は存在しません');

    // 全タスク数を確認
    const allTasks = await tasksRef.get();
    console.log(`全タスク数: ${allTasks.size}`);

    // nameが"Info"のタスクを検索
    const infoTasks = await tasksRef.where('name', '==', 'Info').get();
    console.log(`name="Info"のタスク数: ${infoTasks.size}`);
  } else {
    snapshot.forEach(doc => {
      console.log('見つかりました:', doc.id);
      console.log(JSON.stringify(doc.data(), null, 2));
    });
  }

  process.exit(0);
}

findTask().catch(console.error);
