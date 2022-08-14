const handle404 = async (_logger, app) => {
  // catch 404 and forward to error handler
  app.get('*', (_req, res) => {
    res.status(404).send({
      success: false,
      status: 404,
      message: 'Route not found.',
      data: {}
    });
  });
};

module.exports = { handle404 };
