const handle404 = async (_logger, app) => {
  // catch 404 and forward to error handler
  app.get('*', (_req, res) => {
    res.send(
      { success: false, status: 404, message: 'Route not found.', data: {} },
      404
    );
  });
};

module.exports = { handle404 };
