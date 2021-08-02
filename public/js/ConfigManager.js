/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
const ConfigManager = ({ configuration, sendWebSocket }) => {
  const handleImport = e => {
    if (
      !window.confirm(
        'This action will overwrite your current configuration. Are you sure?'
      )
    ) {
      return;
    }

    const configFile = e.target.files[0];

    var reader = new FileReader(); // File reader to read the file
    // This event listener will happen when the reader has read the file
    reader.addEventListener('load', function () {
      const newConfig = JSON.parse(reader.result); // Parse the result into an object

      // Keep some elements of last config:
      newConfig._id = configuration._id;
      newConfig.pastTrades = configuration.pastTrades;

      // Send new config
      sendWebSocket('setting-update', newConfig);

      window.alert(
        'Config updated! please wait a few moments or reload the page.'
      );
    });

    reader.readAsText(configFile); // Read the uploaded file
  };

  return (
    <div style={{ display: 'flex', 'align-items': 'flex-start' }}>
      <input
        type='file'
        onChange={handleImport}
        class='custom-file-input'
        style={{ width: 0 }}
        id='inputConfigElement'></input>
      <Button
        as='label'
        size='sm'
        variant='dark'
        className='mx-1'
        for='inputConfigElement'>
        Import config
      </Button>
      <Button
        as='a'
        size='sm'
        variant='dark'
        className='mx-1'
        download={`${new Date().toISOString().slice(0, 10)}-binance-bot-config`}
        href={`data:application/json,${JSON.stringify({
          ...configuration,
          configurationDate: new Date(Date.now()).getTime()
        })}`}>
        Export config
      </Button>
    </div>
  );
};
