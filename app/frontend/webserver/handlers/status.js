const handleStatus = async (_funcLogger, app) => {
  app.get('/status', (_req, res) =>
    res.send({
      success: true,
      status: 200,
      message: 'OK',
      data: {}
    })
  );
};

module.exports = { handleStatus };
