const handleStatus = async (funcLogger, app) => {
  app.get('/status', (req, res) =>
    res.send({
      success: true,
      status: 200,
      message: 'OK'
    })
  );
};

module.exports = { handleStatus };
