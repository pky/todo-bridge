const axios = require('axios');
(async () => {
  try {
    const res1 = await axios.post('http://127.0.0.1:5001/demo-rertm/asia-northeast1/collectArticles', {});
    console.log('collectArticles triggered:', res1.status);
    // wait a few seconds
    await new Promise(r => setTimeout(r, 5000));
    const res2 = await axios.post('http://127.0.0.1:5001/demo-rertm/asia-northeast1/generatePersonalizedFeed', {});
    console.log('generatePersonalizedFeed triggered:', res2.status);
  } catch (err) {
    console.error('Error:', err.message);
  }
})();
